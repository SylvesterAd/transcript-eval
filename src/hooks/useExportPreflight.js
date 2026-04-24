// Composes the export page's pre-flight checks. Each sub-result is
// a small discriminated union: { status: 'idle'|'loading'|'ok'|'error', value?, error? }.
//
// Caller (ExportPage.jsx) dispatches state transitions based on the
// combined result:
//   - state_a (install)    : ping.value.installed === false
//   - state_b (envato)     : ping.value.installed && manifest has envato items && envato_session !== 'ok'
//                            (in Phase A, treated as soft warning per Ext.1's missing cookie watcher)
//   - state_c (summary)    : everything else
//
// Polling cadence:
//   - When `phase === 'state_a'`: ping every 2s.
//   - Otherwise: one-shot ping on phase change.

import { useEffect, useReducer, useRef } from 'react'
import { useExtension } from './useExtension.js'
import { apiGet } from './useApi.js'

const initial = {
  ping:     { status: 'idle' },
  manifest: { status: 'idle', additional: {} },  // additional: {variant -> manifest}
  disk:     { status: 'idle' },
}

function reducer(state, action) {
  switch (action.type) {
    case 'ping_loading':       return { ...state, ping: { status: 'loading' } }
    case 'ping_ok':            return { ...state, ping: { status: 'ok', value: action.value } }
    case 'ping_error':         return { ...state, ping: { status: 'error', error: action.error } }
    case 'manifest_loading':   return { ...state, manifest: { ...state.manifest, status: 'loading' } }
    case 'manifest_ok':        return { ...state, manifest: { status: 'ok', value: action.value, additional: {} } }
    case 'manifest_error':     return { ...state, manifest: { status: 'error', error: action.error, additional: {} } }
    case 'manifest_add_ok':    return { ...state, manifest: { ...state.manifest, additional: { ...state.manifest.additional, [action.variant]: action.value } } }
    case 'manifest_add_drop':  {
      const next = { ...state.manifest.additional }
      delete next[action.variant]
      return { ...state, manifest: { ...state.manifest, additional: next } }
    }
    case 'disk_loading':       return { ...state, disk: { status: 'loading' } }
    case 'disk_ok':            return { ...state, disk: { status: 'ok', value: action.value } }
    case 'disk_error':         return { ...state, disk: { status: 'error', error: action.error } }
    default:                   return state
  }
}

/**
 * @param {{
 *   pipelineId: string,
 *   variant: string,
 *   phase: 'init' | 'state_a' | 'state_b' | 'state_c' | 'starting',
 *   additionalVariants?: string[]   // for multi-variant export checkbox in State C
 * }} opts
 */
export function useExportPreflight({ pipelineId, variant, phase, additionalVariants = [] }) {
  const ext = useExtension()
  const [state, dispatch] = useReducer(reducer, initial)
  // Track the most recent additionalVariants for diff-based fetch / drop.
  const lastAdditionalRef = useRef([])

  // Extension ping. Poll every 2s in state_a; otherwise fire once on
  // phase change (we still want to know the current ext state when
  // we're past state_a).
  useEffect(() => {
    let cancelled = false
    let timer = null

    async function pingOnce() {
      dispatch({ type: 'ping_loading' })
      try {
        const value = await ext.ping()
        if (cancelled) return
        dispatch({ type: 'ping_ok', value })
      } catch (e) {
        if (cancelled) return
        dispatch({ type: 'ping_error', error: e.message })
      }
    }

    pingOnce()
    if (phase === 'state_a') {
      timer = setInterval(pingOnce, 2000)
    }

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [phase, ext])

  // Manifest fetch — one-shot per (pipelineId, variant). Re-runs when
  // either changes (e.g., user navigates from variant=A to variant=C).
  useEffect(() => {
    let cancelled = false
    if (!pipelineId || !variant) return
    dispatch({ type: 'manifest_loading' })
    apiGet(`/broll-searches/${encodeURIComponent(pipelineId)}/manifest?variant=${encodeURIComponent(variant)}`)
      .then(value => { if (!cancelled) dispatch({ type: 'manifest_ok', value }) })
      .catch(e => { if (!cancelled) dispatch({ type: 'manifest_error', error: e.message }) })
    return () => { cancelled = true }
  }, [pipelineId, variant])

  // Additional-variant manifests (multi-variant export checkbox).
  // Diff against last list: fetch newly-added, drop newly-removed.
  useEffect(() => {
    const prev = lastAdditionalRef.current
    const next = additionalVariants
    const added = next.filter(v => !prev.includes(v))
    const removed = prev.filter(v => !next.includes(v))
    lastAdditionalRef.current = next.slice()

    for (const v of removed) dispatch({ type: 'manifest_add_drop', variant: v })

    let cancelled = false
    for (const v of added) {
      apiGet(`/broll-searches/${encodeURIComponent(pipelineId)}/manifest?variant=${encodeURIComponent(v)}`)
        .then(value => { if (!cancelled) dispatch({ type: 'manifest_add_ok', variant: v, value }) })
        .catch(() => { /* error per additional variant ignored — treat as zero items */ })
    }
    return () => { cancelled = true }
  }, [additionalVariants, pipelineId])

  // Disk estimate — one-shot on mount; navigator.storage.estimate() is
  // cheap, no need to poll. Browsers without `quota` (Safari) get an
  // 'ok' with quota=null; State C surfaces a soft warning.
  useEffect(() => {
    let cancelled = false
    async function check() {
      dispatch({ type: 'disk_loading' })
      try {
        if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
          if (!cancelled) dispatch({ type: 'disk_ok', value: { quota: null, usage: null, available: null } })
          return
        }
        const { quota, usage } = await navigator.storage.estimate()
        if (cancelled) return
        const available = (typeof quota === 'number' && typeof usage === 'number') ? Math.max(0, quota - usage) : null
        dispatch({ type: 'disk_ok', value: { quota: quota ?? null, usage: usage ?? null, available } })
      } catch (e) {
        if (cancelled) return
        dispatch({ type: 'disk_error', error: e.message })
      }
    }
    check()
    return () => { cancelled = true }
  }, [])

  return state
}
