// State D's long-lived Port lifecycle. Connects to the extension,
// subscribes to the queue broadcasts, drives the pure progressState
// reducer, and handles reconnect on tab-close / reopen.
//
// Call pattern:
//   const { snapshot, portStatus, pendingAction, complete,
//           sendControl, reconnect, mismatched, mismatchInfo } =
//     useExportPort({ exportId, expectedRunId })
//
// Where:
//   exportId       — the export_id we started (for pause/resume/cancel)
//   expectedRunId  — the runId the web app believes is current. If the
//                    extension's initial {type:"state"} snapshot shows
//                    a DIFFERENT runId, we set mismatched=true and the
//                    component renders the "another export is running"
//                    blocker UI.
//
// Reconnect policy:
//   - On mount: connect immediately + send {type:"status"} to force a
//     full snapshot (vs. waiting for the next organic broadcast).
//   - On port.onDisconnect during an active run: try reconnect once
//     immediately (portStatus='reconnecting'). If that second attempt
//     fires onDisconnect again within 2s, portStatus='disconnected'
//     with a user-visible banner + retry button. Do not auto-poll
//     further — the user clicks reconnect.
//   - When the run is already complete (state.complete != null), we
//     don't attempt reconnect — the Port legitimately closed.

import { useEffect, useReducer, useRef, useCallback } from 'react'
import { INITIAL_PROGRESS_STATE, progressReducer } from '../components/export/progressState.js'
import { useExtension } from './useExtension.js'

export function useExportPort({ exportId, expectedRunId } = {}) {
  const ext = useExtension()
  const [state, dispatch] = useReducer(progressReducer, INITIAL_PROGRESS_STATE)

  // Ref to the active Port handle so reconnect + unmount can tear it
  // down. Held in a ref so stale closures don't fire on the wrong
  // Port.
  const portRef = useRef(null)
  const reconnectAttemptRef = useRef(0)
  const unmountedRef = useRef(false)
  const lastStateAtRef = useRef(Date.now())  // for stale-detection if we add it

  // Detect run-ID mismatch from the first snapshot.
  const mismatched = !!(state.snapshot && expectedRunId && state.snapshot.runId &&
                        state.snapshot.runId !== expectedRunId)
  const mismatchInfo = mismatched ? {
    actualRunId: state.snapshot.runId,
    actualExportId: state.snapshot.export_id,
    actualPipelineId: state.snapshot.plan_pipeline_id,
    actualVariants: state.snapshot.variant_labels || [],
    actualRunState: state.snapshot.run_state,
  } : null

  const connect = useCallback(() => {
    if (unmountedRef.current) return
    dispatch({ type: 'port_connecting' })
    let handle
    try {
      handle = ext.openPort('export-tap')
    } catch (e) {
      dispatch({ type: 'port_failed', error: e.message })
      return
    }
    portRef.current = handle
    dispatch({ type: 'port_connected' })

    handle.onMessage((msg) => {
      lastStateAtRef.current = Date.now()
      if (!msg || typeof msg !== 'object') return
      switch (msg.type) {
        case 'state':
          // Ext.5 contract: full snapshot under msg.export (or msg directly;
          // accept both to be resilient).
          dispatch({ type: 'message_state', payload: msg.export || msg })
          break
        case 'progress':
          dispatch({ type: 'message_progress', payload: {
            item_id: msg.item_id,
            phase: msg.phase,
            bytes: msg.bytes,
            total_bytes: msg.total_bytes,
          }})
          break
        case 'item_done':
          dispatch({ type: 'message_item_done', payload: {
            item_id: msg.item_id,
            result: msg.result,
          }})
          break
        case 'complete':
          dispatch({ type: 'message_complete', payload: {
            ok_count: msg.ok_count,
            fail_count: msg.fail_count,
            folder_path: msg.folder_path,
            xml_paths: msg.xml_paths,
          }})
          break
        default:
          // Unknown message type — forward-compat no-op.
          break
      }
    })

    handle.onDisconnect((reason) => {
      if (unmountedRef.current) return
      // If we already received the terminal complete, the disconnect
      // is expected (extension closed the Port at run end). Don't
      // reconnect.
      if (state.complete) {
        dispatch({ type: 'port_disconnected', reason })
        return
      }
      // Retry policy: up to 2 reconnect attempts before surfacing the
      // banner. First attempt is immediate, second after 2s.
      if (reconnectAttemptRef.current >= 2) {
        dispatch({ type: 'port_disconnected', reason })
        return
      }
      reconnectAttemptRef.current += 1
      dispatch({ type: 'port_reconnecting' })
      const delay = reconnectAttemptRef.current === 1 ? 0 : 2000
      setTimeout(() => {
        if (unmountedRef.current) return
        try {
          const h2 = ext.openPort('export-tap')
          portRef.current = h2
          attachReconnectedHandlers(h2)
          dispatch({ type: 'port_connected' })
          // Request a fresh snapshot so the UI rehydrates.
          try { h2.postMessage({ type: 'status', version: 1 }) } catch {}
          reconnectAttemptRef.current = 0
        } catch (e) {
          dispatch({ type: 'port_disconnected', reason: e.message || reason })
        }
      }, delay)
    })

    // First post after connect — ask the extension for its current
    // state even if it hasn't broadcast yet. This is the workflow
    // that makes "close tab, reopen" work: extension replies with a
    // {type:"state"} snapshot describing the in-progress run.
    try { handle.postMessage({ type: 'status', version: 1 }) } catch {}
  }, [ext, state.complete])

  // Reconnected handler re-attaches listeners on the new port.
  // Declared as a ref-closure trick so the onDisconnect callback
  // captures the LATEST connect behavior.
  function attachReconnectedHandlers(h) {
    h.onMessage((msg) => {
      lastStateAtRef.current = Date.now()
      if (!msg || typeof msg !== 'object') return
      switch (msg.type) {
        case 'state':     dispatch({ type: 'message_state', payload: msg.export || msg }); break
        case 'progress':  dispatch({ type: 'message_progress', payload: { item_id: msg.item_id, phase: msg.phase, bytes: msg.bytes, total_bytes: msg.total_bytes }}); break
        case 'item_done': dispatch({ type: 'message_item_done', payload: { item_id: msg.item_id, result: msg.result }}); break
        case 'complete':  dispatch({ type: 'message_complete', payload: { ok_count: msg.ok_count, fail_count: msg.fail_count, folder_path: msg.folder_path, xml_paths: msg.xml_paths }}); break
      }
    })
    h.onDisconnect((reason) => {
      if (unmountedRef.current) return
      if (state.complete) { dispatch({ type: 'port_disconnected', reason }); return }
      if (reconnectAttemptRef.current >= 2) { dispatch({ type: 'port_disconnected', reason }); return }
      reconnectAttemptRef.current += 1
      dispatch({ type: 'port_reconnecting' })
      setTimeout(() => {
        if (unmountedRef.current) return
        try {
          const h2 = ext.openPort('export-tap')
          portRef.current = h2
          attachReconnectedHandlers(h2)
          dispatch({ type: 'port_connected' })
          try { h2.postMessage({ type: 'status', version: 1 }) } catch {}
          reconnectAttemptRef.current = 0
        } catch (e) {
          dispatch({ type: 'port_disconnected', reason: e.message || reason })
        }
      }, 2000)
    })
  }

  // Open the Port on mount; tear down on unmount.
  useEffect(() => {
    unmountedRef.current = false
    connect()
    return () => {
      unmountedRef.current = true
      try { portRef.current?.disconnect() } catch {}
      portRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // connect intentionally NOT in deps — we only open once per mount

  // Manual reconnect button — the UI exposes this when portStatus is
  // 'disconnected' or 'failed'.
  const reconnect = useCallback(() => {
    try { portRef.current?.disconnect() } catch {}
    portRef.current = null
    reconnectAttemptRef.current = 0
    connect()
  }, [connect])

  // Control messages are ONE-SHOT sendMessage, not Port sends. Extension
  // echoes the new run_state via the Port's next snapshot.
  const sendControl = useCallback(async (action) => {
    if (!['pause', 'resume', 'cancel'].includes(action)) {
      throw new Error(`unknown control action: ${action}`)
    }
    // Cancel confirm — mandated by the "don't lose files on a mis-
    // click" policy. We use window.confirm to avoid styling a modal.
    if (action === 'cancel') {
      const ok = window.confirm('Cancel export? Downloaded files will remain on disk.')
      if (!ok) return { cancelled: true }
    }
    dispatch({ type: 'manual_action_sent', action })
    try {
      // ext.send not exported directly; we re-use openPort's underlying
      // chrome.runtime.sendMessage via a lightweight send call. Rather
      // than adding YET another method to useExtension, we send via
      // chrome.runtime.sendMessage inline (same shape as Phase A
      // sendSession/sendExport under the hood). This keeps the hook
      // surface lean.
      const EXT_ID = (await import('../lib/extension-id.js')).EXT_ID
      if (!EXT_ID) throw new Error('EXT_ID empty')
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(EXT_ID, { type: action, version: 1, export_id: exportId }, (r) => {
          const e = chrome.runtime.lastError
          if (e) reject(new Error(e.message || 'chrome.runtime.lastError'))
          else resolve(r)
        })
      })
      if (response?.error) throw new Error(response.error)
      // After 3s, if the snapshot's run_state hasn't echoed the action,
      // clear the pending flag so the button isn't stuck.
      setTimeout(() => {
        if (unmountedRef.current) return
        dispatch({ type: 'manual_action_cleared' })
      }, 3000)
      return response ?? { ok: true }
    } catch (e) {
      // Clear the optimistic state on error — the UI button flips back.
      dispatch({ type: 'manual_action_cleared' })
      throw e
    }
  }, [exportId])

  return {
    snapshot: state.snapshot,
    portStatus: state.portStatus,
    portError: state.portError,
    pendingAction: state.pendingAction,
    complete: state.complete,
    reconnect,
    sendControl,
    mismatched,
    mismatchInfo,
  }
}
