import { useEffect, useReducer, useCallback, useMemo, useState } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import styled from 'styled-components'
import { useExportPreflight } from '../hooks/useExportPreflight.js'
import { useExtension } from '../hooks/useExtension.js'
import { apiPost, apiGet } from '../hooks/useApi.js'
import StateA_Install from '../components/export/StateA_Install.jsx'
import StateB_Session from '../components/export/StateB_Session.jsx'
import StateC_Summary from '../components/export/StateC_Summary.jsx'
import StateD_InProgress from '../components/export/StateD_InProgress.jsx'
import StateE_Complete from '../components/export/StateE_Complete.jsx'
import StateF_Partial from '../components/export/StateF_Partial.jsx'
import { useExportPort } from '../hooks/useExportPort.js'

// FSM:
//   init     → first render, deciding which state to enter
//   state_a  → extension not installed (poll every 2s)
//   state_b  → installed, manifest has envato items, session not detected
//              (Phase A: Ext.1 always reports 'missing'; manual override
//               unblocks; this lives until Ext.4)
//   state_c  → all preconditions met, summary + Start Export
//   state_d  → extension acked; live progress UI driven by useExportPort
//   state_e  → terminal success (fail_count === 0); placeholder UI
//   state_f  → terminal partial (fail_count > 0); placeholder UI

function reducer(state, action) {
  switch (action.type) {
    case 'goto':                  return { ...state, phase: action.phase }
    case 'set_extra_plans':       return { ...state, additionalPlanPipelineIds: action.ids }
    case 'override_session':      return { ...state, sessionOverridden: true }
    case 'set_target_folder':     return { ...state, targetFolder: action.targetFolder }
    case 'export_started':        return {
      ...state,
      phase: 'state_d',
      export_id: action.export_id,
      run_id: action.run_id || null,
      unified_manifest: action.unified_manifest || null,
      variant_labels: action.variant_labels || [],
    }
    case 'export_completed': {
      const fail = action.payload?.fail_count ?? 0
      return { ...state, phase: fail > 0 ? 'state_f' : 'state_e', complete_payload: action.payload }
    }
    case 'set_error':             return { ...state, error: action.error }
    default:                      return state
  }
}

const initialState = {
  phase: 'init',
  additionalPlanPipelineIds: [],
  sessionOverridden: false,
  export_id: null,
  run_id: null,
  complete_payload: null,
  unified_manifest: null,   // captured in onStart; needed by State E
  variant_labels: [],       // captured in onStart; passed to State E
  targetFolder: null,       // user-chosen folder override (StateC "Change folder")
  error: null,
}

const Loader = styled.div`
  max-width: 640px;
  margin: 80px auto;
  padding: 0 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #6b7280;
  text-align: center;
`
const ErrorBox = styled.div`
  max-width: 640px;
  margin: 80px auto;
  padding: 16px 20px;
  border: 1px solid #fca5a5;
  background: #fef2f2;
  color: #991b1b;
  border-radius: 8px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
`

const ChooserWrap = styled.div`
  max-width: 640px;
  margin: 80px auto;
  padding: 0 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
`
const ChooserCard = styled.div`
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 28px 32px;
  background: #fff;
`
const ChooserButton = styled.button`
  display: block;
  width: 100%;
  text-align: left;
  padding: 12px 16px;
  margin: 8px 0;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  background: #fff;
  font-size: 14px;
  cursor: pointer;
  &:hover { background: #f9fafb; border-color: #9ca3af; }
`

export default function ExportPage() {
  const { id: videoGroupId, planPipelineId: planPipelineIdParam } = useParams()
  const navigate = useNavigate()

  // Available plans for this video group. Drives the chooser UI when no
  // planPipelineId is in the URL, the variant label display in State C,
  // and the multi-variant export checkbox.
  const [plans, setPlans] = useState(null)  // null = loading, [] = none
  const [plansError, setPlansError] = useState(null)

  useEffect(() => {
    if (!videoGroupId) return
    let cancelled = false
    apiGet(`/broll/groups/${encodeURIComponent(videoGroupId)}/export-plans`)
      .then(r => { if (!cancelled) setPlans(Array.isArray(r?.plans) ? r.plans : []) })
      .catch(e => { if (!cancelled) { setPlans([]); setPlansError(e.message) } })
    return () => { cancelled = true }
  }, [videoGroupId])

  // No planPipelineId → chooser flow. Auto-redirect when there's exactly
  // one plan; otherwise render the picker.
  useEffect(() => {
    if (planPipelineIdParam) return
    if (!plans || plans.length !== 1) return
    navigate(`/editor/${videoGroupId}/export/${encodeURIComponent(plans[0].plan_pipeline_id)}`, { replace: true })
  }, [planPipelineIdParam, plans, videoGroupId, navigate])

  if (!videoGroupId) {
    return <ErrorBox>Missing project id in URL — expected /editor/:id/export</ErrorBox>
  }

  if (!planPipelineIdParam) {
    if (plans === null) return <Loader>Loading variants…</Loader>
    if (plans.length === 0) {
      return <ErrorBox>{plansError ? `Failed to load plans: ${plansError}` : 'No completed B-Roll plans for this project yet.'}</ErrorBox>
    }
    if (plans.length === 1) return <Loader>Opening variant…</Loader>
    return (
      <ChooserWrap>
        <ChooserCard>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0, marginBottom: 4 }}>Choose a variant to export</h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0, marginBottom: 16 }}>
            This project has {plans.length} completed B-Roll plans. Pick one to export — you'll have a chance to export additional variants on the next screen.
          </p>
          {plans.map(p => (
            <ChooserButton
              key={p.plan_pipeline_id}
              type="button"
              onClick={() => navigate(`/editor/${videoGroupId}/export/${encodeURIComponent(p.plan_pipeline_id)}`)}
            >
              <div style={{ fontWeight: 600 }}>{p.label}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{p.plan_pipeline_id}</div>
            </ChooserButton>
          ))}
        </ChooserCard>
      </ChooserWrap>
    )
  }

  return (
    <ExportFlow
      videoGroupId={videoGroupId}
      planPipelineId={planPipelineIdParam}
      plans={plans || []}
    />
  )
}

function ExportFlow({ videoGroupId, planPipelineId, plans }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const ext = useExtension()
  const [state, dispatch] = useReducer(reducer, initialState)

  // Push the current export phase into the URL as `?step=<phase>` so
  // each step is bookmarkable / shareable. State A→F + the complete /
  // partial endings get distinct URLs without changing the route shape
  // in App.jsx (which would force every existing /editor/:id/export
  // bookmark to break). One-way sync only — opening a deep link goes
  // through pre-flight first and then transitions normally; we don't
  // attempt to short-circuit into State C when someone visits
  // ?step=state_c without a fresh ping/manifest, because the underlying
  // state is meaningless without those checks.
  useEffect(() => {
    if (!state.phase) return
    if (searchParams.get('step') === state.phase) return
    const next = new URLSearchParams(searchParams)
    next.set('step', state.phase)
    setSearchParams(next, { replace: true })
  }, [state.phase, searchParams, setSearchParams])

  const currentPlan = useMemo(
    () => plans.find(p => p.plan_pipeline_id === planPipelineId),
    [plans, planPipelineId],
  )
  const variantLabel = currentPlan?.label || 'Variant'

  const preflight = useExportPreflight({
    pipelineId: planPipelineId,
    phase: state.phase,
    additionalPlanPipelineIds: state.additionalPlanPipelineIds,
  })

  // Decide which phase to enter based on preflight results.
  useEffect(() => {
    // Wait for ping + manifest before deciding.
    if (preflight.ping.status !== 'ok') return
    if (preflight.manifest.status !== 'ok') return

    const installed = !!preflight.ping.value?.installed
    const envatoCount = (preflight.manifest.value?.totals?.by_source?.envato) || 0
    const sessionOk = preflight.ping.value?.envato_session === 'ok'

    let next
    if (!installed) next = 'state_a'
    else if (envatoCount > 0 && !sessionOk && !state.sessionOverridden) next = 'state_b'
    else next = 'state_c'

    const activePhases = ['state_d', 'state_e', 'state_f']
    if (next !== state.phase && !activePhases.includes(state.phase)) {
      dispatch({ type: 'goto', phase: next })
    }
  }, [preflight.ping, preflight.manifest, state.sessionOverridden, state.phase])

  // Other plans available for the multi-variant export checkbox — every
  // plan in the group except the current one.
  const otherPlans = useMemo(
    () => plans.filter(p => p.plan_pipeline_id !== planPipelineId),
    [plans, planPipelineId],
  )

  // Tag each manifest response with its plan's display label so
  // buildManifest() in StateC can populate `unified.variants` (the server
  // returns variant=null now that the URL ?variant param is gone). This is
  // a thin client-side decoration — no schema change needed.
  const labelByPlan = useMemo(() => {
    const m = {}
    for (const p of plans) m[p.plan_pipeline_id] = p.label
    return m
  }, [plans])

  const labelledManifest = useMemo(() => {
    if (preflight.manifest.status !== 'ok' || !preflight.manifest.value) return preflight.manifest.value
    const label = labelByPlan[planPipelineId] || variantLabel
    return { ...preflight.manifest.value, variant: label }
  }, [preflight.manifest, labelByPlan, planPipelineId, variantLabel])

  const labelledAdditional = useMemo(() => {
    const out = {}
    for (const [id, m] of Object.entries(preflight.manifest.additional || {})) {
      out[id] = { ...m, variant: labelByPlan[id] || m?.variant || null }
    }
    return out
  }, [preflight.manifest.additional, labelByPlan])

  const onContinueOverride = useCallback(() => {
    dispatch({ type: 'override_session' })
  }, [])

  const onChangeFolder = useCallback(() => {
    // Chrome's chrome.downloads.download requires paths relative to
    // the user's OS Downloads folder. We can't escape that sandbox
    // from a web page (and even from the extension, true arbitrary
    // folders need the File System Access API + per-file streaming —
    // out of scope). What we CAN do is let the user pick the SUBFOLDER
    // name under Downloads. Default looks like
    // "~/Downloads/transcript-eval/export-<runId>-a/"; user can rename
    // the subfolder portion. Result is dispatched onto state.targetFolder
    // and threaded through to onStart's targetFolder arg.
    const current = state.targetFolder || ''
    const proposed = window.prompt(
      'Save to (path under your Downloads folder):\n\nThe extension can only write inside the OS Downloads folder. Edit the subfolder portion below — leading "~/Downloads/" is for display only.',
      current,
    )
    if (proposed == null) return  // user cancelled
    const trimmed = String(proposed).trim()
    if (!trimmed) {
      window.alert('Folder cannot be empty.')
      return
    }
    dispatch({ type: 'set_target_folder', targetFolder: trimmed })
  }, [state.targetFolder])

  const onTogglePlan = useCallback((id, on) => {
    dispatch({
      type: 'set_extra_plans',
      ids: on
        ? [...new Set([...state.additionalPlanPipelineIds, id])]
        : state.additionalPlanPipelineIds.filter(x => x !== id),
    })
  }, [state.additionalPlanPipelineIds])

  const onStart = useCallback(async ({ unifiedManifest, options, targetFolder }) => {
    // 1. POST /api/exports → returns export_id
    const variantLabels = unifiedManifest.variants.length ? unifiedManifest.variants : [variantLabel]
    const exportRow = await apiPost('/exports', {
      plan_pipeline_id: planPipelineId,
      variant_labels: variantLabels,
      manifest: unifiedManifest,
    })
    const exportId = exportRow.export_id

    // 2. Mint session JWT for the extension (Phase 1 backend).
    const tokenRow = await apiPost('/session-token', {})

    // 3. Push the JWT to the extension (one-shot per spec § "How web
    //    app talks to extension"). Even though Ext.1 already takes a
    //    session, we re-mint per export to avoid stale-token races.
    await ext.sendSession({
      token: tokenRow.token,
      kid: tokenRow.kid,
      user_id: tokenRow.user_id,
      expires_at: tokenRow.expires_at,
    })

    // 4. Send the export to the extension. Ext.5 returns
    //    { ok:true, run_id: '...' } on successful accept. If not
    //    provided (older extension builds), we still transition to
    //    State D — useExportPort will get the runId from the first
    //    snapshot.
    const maybeResponse = await ext.sendExport({
      export_id: exportId,
      manifest: unifiedManifest.items,
      target_folder: targetFolder,
      options: { ...options, variants: variantLabels },
    })

    dispatch({
      type: 'export_started',
      export_id: exportId,
      run_id: maybeResponse?.run_id || null,
      unified_manifest: unifiedManifest,
      variant_labels: variantLabels,
    })
  }, [planPipelineId, variantLabel, ext])

  // Retry failed items — State F button callback. Rebuilds a filtered
  // unified manifest containing only items whose source_item_id is in
  // the failedIds set, then hands off to the existing onStart ceremony
  // (createExport → sendSession → sendExport). onStart's dispatch on
  // success naturally transitions the FSM to state_d.
  //
  // Invariant #5: the filtered manifest is built from
  // state.unified_manifest.items (the authoritative copy from State C),
  // NOT from the Port snapshot (which loses envato_item_url, placements,
  // etc.).
  const onRetryFailed = useCallback(async ({ failedIds }) => {
    if (!state.unified_manifest || !(failedIds instanceof Set) || failedIds.size === 0) return
    const filteredItems = state.unified_manifest.items.filter(
      it => failedIds.has(it.source_item_id)
    )
    if (filteredItems.length === 0) return
    const filteredManifest = {
      ...state.unified_manifest,
      items: filteredItems,
      totals: {
        ...(state.unified_manifest.totals || {}),
        count: filteredItems.length,
      },
    }
    // target_folder and options: reuse the original request's defaults.
    // (State C's onStart passed targetFolder as a display string; we
    // re-send the same string. options.variants stays the same.)
    await onStart({
      unifiedManifest: filteredManifest,
      options: { force_redownload: false, variants: state.variant_labels },
      targetFolder: '~/Downloads/transcript-eval/',  // same default as State C
    })
  }, [state.unified_manifest, state.variant_labels, onStart])

  // Surface explicit errors from the manifest endpoint.
  if (preflight.manifest.status === 'error') {
    return <ErrorBox>Failed to load manifest: {preflight.manifest.error}</ErrorBox>
  }

  // Loading.
  if (state.phase === 'init') {
    return <Loader>Running pre-flight checks…</Loader>
  }

  // State A — install.
  if (state.phase === 'state_a') {
    return (
      <StateA_Install
        variant={variantLabel}
        ping={preflight.ping}
      />
    )
  }

  // State B — session.
  if (state.phase === 'state_b') {
    const envatoCount = preflight.manifest.value?.totals?.by_source?.envato || 0
    return (
      <StateB_Session
        variant={variantLabel}
        envatoItemCount={envatoCount}
        onContinue={onContinueOverride}
      />
    )
  }

  // State C — summary.
  if (state.phase === 'state_c') {
    return (
      <StateC_Summary
        variant={variantLabel}
        manifestResp={labelledManifest}
        additionalManifests={labelledAdditional}
        ping={preflight.ping.value}
        diskValue={preflight.disk.status === 'ok' ? preflight.disk.value : { available: null }}
        onStart={onStart}
        onChangeFolder={onChangeFolder}
        targetFolderOverride={state.targetFolder}
        onTogglePlan={onTogglePlan}
        otherPlans={otherPlans}
      />
    )
  }

  // States D / E / F — live-progress + State E XMEML + State F partial UI.
  if (state.phase === 'state_d' || state.phase === 'state_e' || state.phase === 'state_f') {
    return (
      <ActiveRun
        variant={variantLabel}
        exportId={state.export_id}
        expectedRunId={state.run_id}
        phase={state.phase}
        completePayload={state.complete_payload}
        unifiedManifest={state.unified_manifest}
        variantLabels={state.variant_labels}
        onRetryFailed={onRetryFailed}
        onComplete={(payload) => dispatch({ type: 'export_completed', payload })}
      />
    )
  }

  return <ErrorBox>Unknown phase: {state.phase}</ErrorBox>
}

// ActiveRun wraps the State D / E / F rendering so that useExportPort
// is mounted only while we're actually in those phases. Pulling this
// out as a child component keeps ExportPage.jsx's FSM clean — the Port
// lifecycle lives only for the duration of the active run.
function ActiveRun({
  variant, exportId, expectedRunId, phase, completePayload,
  unifiedManifest, variantLabels, onRetryFailed, onComplete,
}) {
  const port = useExportPort({ exportId, expectedRunId })

  // When the Port reports completion, notify parent to transition FSM.
  useEffect(() => {
    if (port.complete && phase === 'state_d') {
      onComplete(port.complete)
    }
  }, [port.complete, phase, onComplete])

  if (phase === 'state_e') {
    return (
      <StateE_Complete
        complete={completePayload}
        exportId={exportId}
        variantLabels={variantLabels}
        unifiedManifest={unifiedManifest}
      />
    )
  }
  if (phase === 'state_f') {
    return (
      <StateF_Partial
        complete={completePayload}
        snapshot={port.snapshot}
        exportId={exportId}
        variantLabels={variantLabels}
        unifiedManifest={unifiedManifest}
        onRetryFailed={onRetryFailed}
      />
    )
  }
  // state_d
  return (
    <StateD_InProgress
      variant={variant}
      snapshot={port.snapshot}
      portStatus={port.portStatus}
      portError={port.portError}
      pendingAction={port.pendingAction}
      reconnect={port.reconnect}
      sendControl={port.sendControl}
      mismatched={port.mismatched}
      mismatchInfo={port.mismatchInfo}
    />
  )
}
