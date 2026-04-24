import { useEffect, useReducer, useCallback, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import styled from 'styled-components'
import { useExportPreflight } from '../hooks/useExportPreflight.js'
import { useExtension } from '../hooks/useExtension.js'
import { apiPost, apiGet } from '../hooks/useApi.js'
import StateA_Install from '../components/export/StateA_Install.jsx'
import StateB_Session from '../components/export/StateB_Session.jsx'
import StateC_Summary from '../components/export/StateC_Summary.jsx'

// FSM:
//   init     → first render, deciding which state to enter
//   state_a  → extension not installed (poll every 2s)
//   state_b  → installed, manifest has envato items, session not detected
//              (Phase A: Ext.1 always reports 'missing'; manual override
//               unblocks; this lives until Ext.4)
//   state_c  → all preconditions met, summary + Start Export
//   starting → user clicked Start Export; extension acked; placeholder
//              for State D (in-progress) which lands in next plan

function reducer(state, action) {
  switch (action.type) {
    case 'goto':                  return { ...state, phase: action.phase }
    case 'set_extra_variants':    return { ...state, additionalVariants: action.variants }
    case 'override_session':      return { ...state, sessionOverridden: true }
    case 'export_started':        return { ...state, phase: 'starting', export_id: action.export_id }
    case 'set_error':             return { ...state, error: action.error }
    default:                      return state
  }
}

const initialState = {
  phase: 'init',
  additionalVariants: [],
  sessionOverridden: false,
  export_id: null,
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
const Starting = styled.div`
  max-width: 640px;
  margin: 80px auto;
  padding: 24px 32px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  & h1 { font-size: 18px; margin: 0 0 8px; }
  & p { color: #6b7280; font-size: 14px; line-height: 1.5; }
  & code { background: #f3f4f6; padding: 1px 6px; border-radius: 3px; font-size: 12px; }
`

export default function ExportPage() {
  const { id: pipelineId } = useParams()
  const [searchParams] = useSearchParams()
  const variant = searchParams.get('variant') || 'A'
  const ext = useExtension()
  const [state, dispatch] = useReducer(reducer, initialState)

  const preflight = useExportPreflight({
    pipelineId,
    variant,
    phase: state.phase,
    additionalVariants: state.additionalVariants,
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

    if (next !== state.phase && state.phase !== 'starting') {
      dispatch({ type: 'goto', phase: next })
    }
  }, [preflight.ping, preflight.manifest, state.sessionOverridden, state.phase])

  // Discover other variants for the multi-variant checkbox. Phase A
  // approach: hit the manifest endpoint without ?variant to learn what
  // variants exist for this pipeline. To keep this cheap and avoid a
  // schema change, a lightweight implementation is: fetch the all-
  // variant endpoint and inspect distinct `variant_label` values from
  // the items array. Caveat: returns up to N items; for large pipelines
  // this is wasteful. Alternative (deferred): a dedicated endpoint
  // returning just the variant list. Acceptable for Phase A.
  const [knownVariants, setKnownVariants] = useState([])

  useEffect(() => {
    if (!pipelineId) return
    let cancelled = false
    apiGet(`/broll-searches/${encodeURIComponent(pipelineId)}/manifest`)
      .then(r => {
        if (cancelled) return
        const labels = new Set()
        for (const it of r.items || []) {
          if (it.variant_label) labels.add(it.variant_label)
        }
        // Filter to labels that aren't the current variant. Variant
        // values in broll_searches are stored as "Variant X" strings;
        // the URL ?variant param is just the letter. Match flexibly.
        const norm = (v) => String(v).replace(/^Variant\s+/i, '').trim()
        const others = [...labels].map(norm).filter(v => v && v !== variant)
        setKnownVariants([...new Set(others)])
      })
      .catch(() => { if (!cancelled) setKnownVariants([]) })
    return () => { cancelled = true }
  }, [pipelineId, variant])

  const onContinueOverride = useCallback(() => {
    dispatch({ type: 'override_session' })
  }, [])

  const onChangeFolder = useCallback(() => {
    // Phase A defers File System Access API — see plan § Scope.
    window.alert('Folder picker coming in a later release. For now exports save to ~/Downloads/transcript-eval/')
  }, [])

  const onToggleVariant = useCallback((v, on) => {
    dispatch({
      type: 'set_extra_variants',
      variants: on
        ? [...new Set([...state.additionalVariants, v])]
        : state.additionalVariants.filter(x => x !== v),
    })
  }, [state.additionalVariants])

  const onStart = useCallback(async ({ unifiedManifest, options, targetFolder }) => {
    // 1. POST /api/exports → returns export_id
    const variantLabels = unifiedManifest.variants.length ? unifiedManifest.variants : [variant]
    const exportRow = await apiPost('/exports', {
      plan_pipeline_id: pipelineId,
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

    // 4. Send the export to the extension. Phase A is one-shot;
    //    Ext.5 will replace this with a long-lived Port that pushes
    //    progress back, which State D consumes (next plan).
    await ext.sendExport({
      export_id: exportId,
      manifest: unifiedManifest.items,
      target_folder: targetFolder,
      options: { ...options, variants: variantLabels },
    })

    dispatch({ type: 'export_started', export_id: exportId })
  }, [pipelineId, variant, ext])

  // Fail-fast on missing pipelineId.
  if (!pipelineId) {
    return <ErrorBox>Missing pipeline id in URL — expected /editor/:id/export</ErrorBox>
  }

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
        variant={variant}
        ping={preflight.ping}
      />
    )
  }

  // State B — session.
  if (state.phase === 'state_b') {
    const envatoCount = preflight.manifest.value?.totals?.by_source?.envato || 0
    return (
      <StateB_Session
        variant={variant}
        envatoItemCount={envatoCount}
        onContinue={onContinueOverride}
      />
    )
  }

  // State C — summary.
  if (state.phase === 'state_c') {
    return (
      <StateC_Summary
        variant={variant}
        manifestResp={preflight.manifest.value}
        additionalManifests={preflight.manifest.additional}
        ping={preflight.ping.value}
        diskValue={preflight.disk.status === 'ok' ? preflight.disk.value : { available: null }}
        onStart={onStart}
        onChangeFolder={onChangeFolder}
        onToggleVariant={onToggleVariant}
        availableExtraVariants={knownVariants || []}
      />
    )
  }

  // Starting — placeholder. Real State D lands once Ext.5's Port
  // is live and the next webapp plan is executed.
  if (state.phase === 'starting') {
    return (
      <Starting>
        <h1>Export started</h1>
        <p>The Export Helper is downloading your clips. Live progress will appear here once the extension's queue is fully wired (next phase).</p>
        <p>Export ID: <code>{state.export_id}</code></p>
      </Starting>
    )
  }

  return <ErrorBox>Unknown phase: {state.phase}</ErrorBox>
}
