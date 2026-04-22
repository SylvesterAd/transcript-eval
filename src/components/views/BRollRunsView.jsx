import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useApi, apiGet, apiDelete, apiPost } from '../../hooks/useApi.js'
import { ChevronDown, ChevronRight, Trash2, Copy, Check, Square, RotateCcw, ExternalLink, Play, Loader2 } from 'lucide-react'

function StatusBadge({ status }) {
  const styles = {
    pending: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    running: 'bg-blue-900/50 text-blue-400 border-blue-800',
    stopping: 'bg-amber-900/50 text-amber-400 border-amber-800',
    interrupted: 'bg-amber-900/50 text-amber-400 border-amber-800',
    complete: 'bg-emerald-900/50 text-emerald-400 border-emerald-800',
    failed: 'bg-red-900/50 text-red-400 border-red-800',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 text-xs rounded border ${styles[status] || styles.pending}`}>
      {status}
    </span>
  )
}

function PhaseBadge({ phase, videoLabel }) {
  const label = videoLabel ? `: ${videoLabel}` : ''
  if (phase === 'analysis') return <span className="text-[10px] px-1.5 py-0.5 rounded border border-sky-800 bg-sky-900/30 text-sky-300 truncate max-w-48">Analysis{label}</span>
  if (phase === 'plan') return <span className="text-[10px] px-1.5 py-0.5 rounded border border-amber-800 bg-amber-900/30 text-amber-300">Plan (Favorite)</span>
  if (phase === 'alt_plan') return <span className="text-[10px] px-1.5 py-0.5 rounded border border-violet-800 bg-violet-900/30 text-violet-300 truncate max-w-48">Alt Plan{label}</span>
  return null
}

function TypeBadge({ type }) {
  if (!type) return null
  const isVideo = type.startsWith('video')
  const isProgrammatic = type === 'programmatic'
  const cls = isVideo
    ? 'bg-emerald-900/30 text-emerald-400 border-emerald-800/50'
    : isProgrammatic
    ? 'bg-purple-900/30 text-purple-400 border-purple-800/50'
    : 'bg-sky-900/30 text-sky-400 border-sky-800/50'
  return <span className={`px-1.5 py-0.5 rounded text-[10px] border ${cls}`}>{type}</span>
}

function formatCost(cost) {
  if (!cost) return '-'
  return cost < 1 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
}
function formatTokens(tokens) {
  if (!tokens) return '-'
  if (tokens > 1000000) return `${(tokens / 1000000).toFixed(1)}M`
  if (tokens > 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}
function formatRuntime(ms) {
  if (!ms) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
function timeAgo(dateStr) {
  if (!dateStr) return ''
  const ts = typeof dateStr === 'number' ? dateStr : new Date(dateStr).getTime()
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
function parseMeta(run) {
  try { return JSON.parse(run.metadata_json || '{}') } catch { return {} }
}

export default function BRollRunsView() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { data, loading, refetch } = useApi('/broll/runs')
  const refetchRef = useRef(refetch)
  refetchRef.current = refetch
  const hasActiveRef = useRef(false)

  const urlPipelineId = searchParams.get('run')
  const urlStageIndex = searchParams.get('stage') != null ? parseInt(searchParams.get('stage')) : null

  const setUrlRun = useCallback((pipelineId, stageIndex) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (pipelineId != null) next.set('run', pipelineId)
      else next.delete('run')
      if (stageIndex != null) next.set('stage', stageIndex)
      else next.delete('stage')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const runs = data?.runs || (Array.isArray(data) ? data : [])
  const activePipelines = data?.activePipelines || []

  // Track if any pipelines are active
  useEffect(() => {
    hasActiveRef.current = activePipelines.some(p => p.status === 'running')
  }, [activePipelines])

  // Poll every 3s when there are active pipelines
  useEffect(() => {
    const interval = setInterval(() => {
      if (hasActiveRef.current) refetchRef.current(true)
    }, 3000)
    return () => clearInterval(interval)
  }, [])

  // Group completed runs by pipelineId
  const pipelines = useMemo(() => {
    if (!runs.length) return []
    const map = {}
    for (const run of runs) {
      const meta = parseMeta(run)
      const pid = meta.pipelineId || `standalone-${run.id}`
      if (!map[pid]) {
        map[pid] = {
          pipelineId: pid,
          strategyName: run.strategy_name || `Strategy #${run.strategy_id}`,
          strategyKind: run.strategy_kind,
          videoTitle: run.video_title || `Video #${run.video_id}`,
          videoId: run.video_id,
          groupId: run.group_id || JSON.parse(run.metadata_json || '{}').groupId || null,
          createdAt: run.created_at,
          stages: [],
          subRuns: [],
          totalCost: 0,
          totalTokens: 0,
          totalRuntime: 0,
          status: 'complete',
          hasAnalysisPhase: false,
        }
      }
      const p = map[pid]
      if (meta.isSubRun) {
        p.subRuns.push({ ...run, _meta: meta })
      } else {
        p.stages.push({ ...run, _meta: meta })
      }
      p.totalCost += run.cost || 0
      p.totalTokens += (run.tokens_in || 0) + (run.tokens_out || 0)
      p.totalRuntime += run.runtime_ms || 0
      if (run.status === 'failed') p.status = 'failed'
      if (meta.totalStages) p.expectedStages = meta.totalStages
      if (meta.phase === 'analysis') p.hasAnalysisPhase = true
      if (meta.phase === 'alt_plan') p.hasAltPlanPhase = true
      if (run.created_at > p.createdAt) p.createdAt = run.created_at
    }
    for (const p of Object.values(map)) {
      p.stages.sort((a, b) => (a._meta.stageIndex || 0) - (b._meta.stageIndex || 0))
      p.subRuns.sort((a, b) => (a._meta.stageIndex || 0) - (b._meta.stageIndex || 0) || (a._meta.subIndex || 0) - (b._meta.subIndex || 0))

      // Create synthetic stage entries for orphaned sub-runs (no parent main stage)
      const stageIndices = new Set(p.stages.map(s => s._meta.stageIndex))
      const orphanStageIndices = new Set()
      for (const sr of p.subRuns) {
        if (!stageIndices.has(sr._meta.stageIndex)) orphanStageIndices.add(sr._meta.stageIndex)
      }
      for (const si of orphanStageIndices) {
        const subs = p.subRuns.filter(sr => sr._meta.stageIndex === si)
        const first = subs[0]
        const allSubsComplete = subs.every(sr => sr.status === 'complete')
        p.stages.push({
          id: `synthetic-${si}`,
          status: allSubsComplete ? 'complete' : 'interrupted',
          strategy_id: first.strategy_id,
          video_id: first.video_id,
          tokens_in: subs.reduce((s, r) => s + (r.tokens_in || 0), 0),
          tokens_out: subs.reduce((s, r) => s + (r.tokens_out || 0), 0),
          cost: subs.reduce((s, r) => s + (r.cost || 0), 0),
          runtime_ms: subs.reduce((s, r) => s + (r.runtime_ms || 0), 0),
          output_text: allSubsComplete ? `${subs.length} sub-runs` : `${subs.length} sub-runs completed (stage interrupted before finishing)`,
          _meta: { ...first._meta, isSubRun: false, subIndex: undefined, subLabel: undefined },
        })
      }
      if (orphanStageIndices.size) p.stages.sort((a, b) => (a._meta.stageIndex || 0) - (b._meta.stageIndex || 0))
    }
    // Filter out pipelines that are still active (shown separately)
    const activePids = new Set(activePipelines.filter(p => p.status === 'running').map(p => p.pipelineId))
    const result = Object.values(map).filter(p => !activePids.has(p.pipelineId))
    // Detect interrupted pipelines: have expectedStages but fewer completed
    for (const p of result) {
      if (p.status === 'complete' && p.expectedStages && p.stages.length < p.expectedStages) {
        p.status = 'interrupted'
      }
    }
    return result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }, [runs, activePipelines])

  const totals = pipelines.reduce((acc, p) => ({ cost: acc.cost + p.totalCost, tokens: acc.tokens + p.totalTokens, count: acc.count + 1 }), { cost: 0, tokens: 0, count: 0 })

  if (loading) return <div className="p-6 text-zinc-500 text-sm">Loading...</div>

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">B-Roll Runs</h2>
        <div className="flex items-center gap-4 text-xs">
          <span className="text-zinc-400">
            Total: <span className="text-zinc-200 font-medium">{formatCost(totals.cost)}</span>
            <span className="text-zinc-600 ml-1">({totals.count} pipeline{totals.count !== 1 ? 's' : ''} · {formatTokens(totals.tokens)} tokens)</span>
          </span>
        </div>
      </div>

      {/* Active pipelines */}
      {activePipelines.filter(p => p.status === 'running').map(pipeline => {
        // Collect completed stages and sub-runs for this active pipeline
        const completedStages = runs.filter(r => {
          try { return JSON.parse(r.metadata_json || '{}').pipelineId === pipeline.pipelineId && !JSON.parse(r.metadata_json || '{}').isSubRun } catch { return false }
        }).map(r => ({ ...r, _meta: JSON.parse(r.metadata_json || '{}') })).sort((a, b) => (a._meta.stageIndex || 0) - (b._meta.stageIndex || 0))
        const completedSubRuns = runs.filter(r => {
          try { const m = JSON.parse(r.metadata_json || '{}'); return m.pipelineId === pipeline.pipelineId && m.isSubRun } catch { return false }
        }).map(r => ({ ...r, _meta: JSON.parse(r.metadata_json || '{}') }))
        return <ActivePipelineRow key={pipeline.pipelineId} pipeline={pipeline} completedStages={completedStages} completedSubRuns={completedSubRuns} urlExpanded={urlPipelineId === pipeline.pipelineId} setUrlRun={setUrlRun} urlStageIndex={urlPipelineId === pipeline.pipelineId ? urlStageIndex : null} />
      })}

      {/* Completed pipelines */}
      {!pipelines.length && !activePipelines.some(p => p.status === 'running') ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-zinc-500 text-sm">No B-Roll runs yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {pipelines.map(pipeline => (
            <PipelineRow key={pipeline.pipelineId} pipeline={pipeline} onDeleted={refetch} urlExpanded={urlPipelineId === pipeline.pipelineId} urlStageIndex={urlPipelineId === pipeline.pipelineId ? urlStageIndex : null} setUrlRun={setUrlRun} />
          ))}
        </div>
      )}
    </div>
  )
}

function ActivePipelineRow({ pipeline, completedStages = [], completedSubRuns = [], urlExpanded, setUrlRun, urlStageIndex }) {
  const { pipelineId, strategyName, videoTitle, stageIndex, totalStages, stageName, phase, videoLabel, completedStages: doneCount, startedAt } = pipeline
  const progress = totalStages > 0 ? (doneCount / totalStages) * 100 : 0
  const [expanded, setExpanded] = useState(urlExpanded || false)

  function toggleExpanded() {
    const next = !expanded
    setExpanded(next)
    setUrlRun?.(next ? pipelineId : null, null)
  }
  const [stopping, setStopping] = useState(false)

  async function handleStop() {
    setStopping(true)
    await apiPost(`/broll/pipeline/${pipelineId}/stop`).catch(() => {})
  }

  // Build stage breadcrumbs
  const breadcrumbs = []
  for (let i = 0; i < totalStages; i++) {
    const done = completedStages.find(s => s._meta.stageIndex === i)
    let status = 'waiting'
    if (i < stageIndex) status = 'complete'
    else if (i === stageIndex) status = 'running'
    breadcrumbs.push({ index: i, status, name: done?._meta?.stageName || (i === stageIndex ? stageName : null), phase: done?._meta?.phase || (i === stageIndex ? phase : null), videoLabel: done?._meta?.videoLabel || (i === stageIndex ? videoLabel : null) })
  }

  return (
    <div className="bg-zinc-900 border border-blue-800/50 rounded-lg overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-3 cursor-pointer" onClick={toggleExpanded}>
        <div className="shrink-0 text-zinc-500">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>

        <StatusBadge status={stopping ? 'stopping' : 'running'} />

        {phase && <PhaseBadge phase={phase} videoLabel={videoLabel} />}

        <div className="min-w-0 shrink">
          <span className="text-sm font-medium truncate">{strategyName}</span>
        </div>

        <div className="flex items-center gap-1.5 text-xs text-zinc-400">
          <span>Group #{pipeline.groupId || '?'}</span>
          {pipeline.groupId && (
            <Link to={`/editor/${pipeline.groupId}/brolls`} target="_blank" onClick={e => e.stopPropagation()} className="text-zinc-500 hover:text-primary-fixed transition-colors" title="Open in editor">
              <ExternalLink size={12} />
            </Link>
          )}
        </div>

        {/* Progress bar */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden max-w-32">
              <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${progress}%` }} />
            </div>
            <span className="text-[10px] text-zinc-500 shrink-0">{doneCount}/{totalStages}</span>
          </div>
          {stageName && (
            <div className="text-[10px] text-blue-400 mt-0.5">
              {stageName}
              {pipeline.subTotal ? ` (${pipeline.subDone || 0}/${pipeline.subTotal})` : ''}
              {pipeline.gpuStage ? <span className="text-cyan-400/70 ml-1">· GPU: {pipeline.gpuStage}{pipeline.gpuStatus ? ` (${pipeline.gpuStatus})` : ''}</span> : ''}
              {pipeline.subStatus ? <span className="text-amber-400/70 ml-1">· {pipeline.subStatus}</span> : ''}
            </div>
          )}
        </div>

        <span className="text-xs text-zinc-600 w-16 text-right shrink-0">{timeAgo(startedAt)}</span>
        {stopping ? (
          <span className="text-[10px] text-amber-400 shrink-0 animate-pulse">Stopping...</span>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); handleStop() }}
            className="text-zinc-500 hover:text-red-400 shrink-0 p-0.5 rounded hover:bg-red-900/30 transition-colors"
            title="Stop pipeline"
          >
            <Square size={12} fill="currentColor" />
          </button>
        )}
      </div>

      {/* Stage breadcrumbs */}
      <div className="px-4 pb-2 flex items-center gap-1 flex-wrap">
        {breadcrumbs.map((s, i) => (
          <div key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-zinc-700 text-[10px]">&rarr;</span>}
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              s.status === 'complete' ? 'bg-emerald-900/40 text-emerald-400' :
              s.status === 'running' ? 'bg-blue-900/40 text-blue-400 animate-pulse' :
              'bg-zinc-800/50 text-zinc-600'
            }`}>
              {s.name || `Stage ${i + 1}`}
              {s.status === 'running' && pipeline.subTotal ? ` (${pipeline.subDone || 0}/${pipeline.subTotal})` : ''}
            </span>
          </div>
        ))}
      </div>

      {/* Expanded: all stages (complete + running + pending) */}
      {expanded && (
        <div className="border-t border-zinc-800">
          {breadcrumbs.map((s, idx) => {
            const done = completedStages.find(st => st._meta.stageIndex === s.index)
            const subs = done ? completedSubRuns.filter(sr => sr._meta.stageIndex === s.index) : []
            if (done) {
              return <StageRow key={done.id} stage={done} index={idx} subRuns={subs} pipelineId={pipelineId} setUrlRun={setUrlRun} urlShowOutput={urlStageIndex === s.index} />
            }
            // Running or pending stage
            const isRunning = s.status === 'running'
            const hasSubTotal = isRunning && pipeline.subTotal > 0
            const stageSubs = completedSubRuns.filter(sr => sr._meta.stageIndex === s.index)
            return <LiveStageRow key={`stage-${s.index}`} breadcrumb={s} isRunning={isRunning} pipeline={pipeline} subRuns={stageSubs} />
          })}
        </div>
      )}
    </div>
  )
}

function PipelineRow({ pipeline, onDeleted, urlExpanded, urlStageIndex, setUrlRun }) {
  const [expanded, setExpanded] = useState(urlExpanded || false)
  const [retrying, setRetrying] = useState(false)

  function toggleExpanded() {
    const next = !expanded
    setExpanded(next)
    setUrlRun(next ? pipeline.pipelineId : null, null)
  }

  async function handleDelete(e) {
    e.stopPropagation()
    const ids = [...pipeline.stages, ...pipeline.subRuns].map(s => s.id)
    for (const id of ids) {
      await apiDelete(`/broll/runs/${id}`).catch(() => {})
    }
    onDeleted?.()
  }

  const isIncomplete = pipeline.status === 'failed' || pipeline.status === 'interrupted'

  async function handleRerunFrom(stageIndex) {
    setRetrying(true)
    try {
      await apiPost(`/broll/pipeline/${pipeline.pipelineId}/resume`, { fromStage: stageIndex })
      onDeleted?.()
      setTimeout(() => onDeleted?.(), 1500)
      setTimeout(() => onDeleted?.(), 4000)
    } catch (err) {
      console.error('Re-run from stage failed:', err)
    } finally {
      setRetrying(false)
    }
  }

  // Extract the source plan pipeline ID from alt/keywords pipeline IDs
  // alt-{planPipelineId}-{videoId}-{ts} or kw-{planPipelineId}-{ts}
  function getSourcePlanPipelineId(pid) {
    if (pid.startsWith('alt-')) return pid.replace(/^alt-/, '').replace(/-\d+-\d+$/, '')
    if (pid.startsWith('kw-')) return pid.replace(/^kw-/, '').replace(/-\d+$/, '')
    if (pid.startsWith('bs-')) return pid.replace(/^bs-/, '').replace(/-\d+$/, '')
    return null
  }

  const isAltPipeline = pipeline.pipelineId.startsWith('alt-')
  const isKwPipeline = pipeline.pipelineId.startsWith('kw-')
  const isBsPipeline = pipeline.pipelineId.startsWith('bs-')
  const sourcePlanId = getSourcePlanPipelineId(pipeline.pipelineId)

  async function handleResume(e) {
    e.stopPropagation()
    if (!pipeline.stages.length) return
    setRetrying(true)
    try {
      if (isAltPipeline && sourcePlanId) {
        await apiPost(`/broll/pipeline/${sourcePlanId}/run-alt-plans`, {})
      } else if (isKwPipeline && sourcePlanId) {
        await apiPost(`/broll/pipeline/${sourcePlanId}/run-keywords`, {})
      } else if (isBsPipeline && sourcePlanId) {
        await apiPost(`/broll/pipeline/${sourcePlanId}/run-broll-search`, {})
      } else {
        await apiPost(`/broll/pipeline/${pipeline.pipelineId}/resume`, {})
      }
      onDeleted?.()
      setTimeout(() => onDeleted?.(), 1500)
      setTimeout(() => onDeleted?.(), 4000)
    } catch (err) {
      console.error('Resume failed:', err)
    } finally {
      setRetrying(false)
    }
  }

  async function handleRestart(e) {
    e.stopPropagation()
    if (!pipeline.stages.length) return
    setRetrying(true)
    try {
      // Alt, keywords, and search pipelines: re-trigger from their dedicated endpoints
      if (isAltPipeline && sourcePlanId) {
        await apiPost(`/broll/pipeline/${sourcePlanId}/run-alt-plans`, {})
      } else if (isKwPipeline && sourcePlanId) {
        await apiPost(`/broll/pipeline/${sourcePlanId}/run-keywords`, {})
      } else if (isBsPipeline && sourcePlanId) {
        await apiPost(`/broll/pipeline/${sourcePlanId}/run-broll-search`, {})
      } else {
        const firstStage = pipeline.stages[0]
        const strategyId = firstStage.strategy_id
        const videoId = firstStage.video_id
        const { supabase } = await import('../../lib/supabaseClient.js')
        const headers = {}
        if (supabase) {
          const { data } = await supabase.auth.getSession()
          if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
        }
        const versRes = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/broll/strategies/${strategyId}/versions`, { headers })
        const versions = await versRes.json()
        const latestVersion = versions?.[0]
        if (!latestVersion) throw new Error('No strategy version found')

        await apiPost(`/broll/strategies/${strategyId}/versions/${latestVersion.id}/run`, {
          video_id: videoId,
          group_id: parseInt(pipeline.stages[0]?._meta?.groupId) || null,
          transcript_source: 'raw',
        })
      }
      onDeleted?.()
      setTimeout(() => onDeleted?.(), 1500)
      setTimeout(() => onDeleted?.(), 4000)
    } catch (err) {
      console.error('Restart failed:', err)
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
      {/* Pipeline header */}
      <div className="p-3 flex items-center gap-3 cursor-pointer" onClick={toggleExpanded}>
        <div className="shrink-0 text-zinc-500">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <StatusBadge status={pipeline.status} />
        {pipeline.hasAnalysisPhase && <PhaseBadge phase="analysis" />}
        {pipeline.hasAnalysisPhase && <span className="text-zinc-600 text-xs">+</span>}
        <PhaseBadge phase="plan" />
        {pipeline.hasAltPlanPhase && <><span className="text-zinc-600 text-xs">+</span><PhaseBadge phase="alt_plan" /></>}

        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium truncate">{pipeline.strategyName}</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-400" onClick={e => e.stopPropagation()}>
          <span>Group #{pipeline.groupId || '?'}</span>
          {pipeline.groupId && (
            <Link to={`/editor/${pipeline.groupId}/brolls`} target="_blank" className="text-zinc-500 hover:text-[#cefc00] transition-colors" title="Open in editor">
              <ExternalLink size={12} />
            </Link>
          )}
        </div>

        {/* Progress bar */}
        <div className="w-24 shrink-0">
          <div className="flex items-center gap-1.5">
            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${pipeline.status === 'failed' ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: '100%' }} />
            </div>
            <span className="text-[10px] text-zinc-500 w-8 text-right">{pipeline.stages.length}</span>
          </div>
        </div>

        <span className="text-xs text-zinc-500 w-16 text-right shrink-0">{formatCost(pipeline.totalCost)}</span>
        <span className="text-xs text-zinc-500 w-12 text-right shrink-0">{formatTokens(pipeline.totalTokens)}</span>
        <span className="text-xs text-zinc-500 w-14 text-right shrink-0">{formatRuntime(pipeline.totalRuntime)}</span>
        <span className="text-xs text-zinc-600 w-16 text-right shrink-0">{timeAgo(pipeline.createdAt)}</span>
        <button
          onClick={handleResume}
          disabled={retrying}
          className="text-zinc-500 hover:text-emerald-400 shrink-0 p-0.5 rounded hover:bg-emerald-900/30 transition-colors disabled:opacity-50"
          title="Resume pipeline (keep completed stages, re-run failed/missing)"
        >
          <Play size={12} />
        </button>
        <button
          onClick={handleRestart}
          disabled={retrying}
          className="text-zinc-500 hover:text-blue-400 shrink-0 p-0.5 rounded hover:bg-blue-900/30 transition-colors disabled:opacity-50"
          title="Restart pipeline from scratch (new run)"
        >
          <RotateCcw size={12} />
        </button>
        <button
          onClick={handleDelete}
          className="text-zinc-600 hover:text-red-400 shrink-0 p-0.5 rounded hover:bg-red-900/30 transition-colors"
          title="Delete pipeline"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Expanded: stage list with nested sub-runs */}
      {expanded && (
        <div className="border-t border-zinc-800">
          {pipeline.stages.map((stage, i) => {
            const stageIdx = stage._meta.stageIndex ?? i
            const subs = pipeline.subRuns.filter(s => s._meta.stageIndex === stageIdx)
            return <StageRow key={stage.id} stage={stage} index={i} subRuns={subs} pipelineId={pipeline.pipelineId} setUrlRun={setUrlRun} urlShowOutput={urlStageIndex === stageIdx} onRerunFrom={handleRerunFrom} />
          })}
        </div>
      )}
    </div>
  )
}

function FormattedOutput({ text }) {
  if (!text) return <span className="text-zinc-500">(no output)</span>

  // Try to parse as JSON (possibly wrapped in ```json ... ```)
  let parsed = null
  try {
    const jsonStr = text.match(/```json\s*([\s\S]*?)```/)?.[1] || text
    parsed = JSON.parse(jsonStr)
  } catch {}

  if (!parsed || typeof parsed !== 'object') {
    // Not JSON — render as text with basic formatting
    return <pre className="text-xs text-zinc-300 whitespace-pre-wrap">{text}</pre>
  }

  // Unwrap arrays of stringified JSON (e.g. from enrichment stages)
  if (Array.isArray(parsed) && parsed.length && typeof parsed[0] === 'string') {
    const unwrapped = parsed.map(item => {
      if (typeof item === 'string') { try { return JSON.parse(item) } catch {} }
      return item
    })
    // Wrap in a chapters structure for cleaner display
    const allObjects = unwrapped.every(item => item && typeof item === 'object')
    if (allObjects) {
      return <JsonTree data={{ total_chapters: unwrapped.length, chapters: unwrapped }} depth={0} />
    }
  }

  return <JsonTree data={parsed} depth={0} />
}

function JsonTree({ data, depth = 0, keyName }) {
  const indent = depth * 16

  if (data === null || data === undefined) return <span className="text-zinc-500">null</span>
  if (typeof data === 'boolean') return <span className="text-amber-400">{String(data)}</span>
  if (typeof data === 'number') return <span className="text-sky-400">{data}</span>
  if (typeof data === 'string') {
    // Timecodes
    if (/^\[?\d{2}:\d{2}:\d{2}\]?$/.test(data)) return <span className="text-violet-400">{data}</span>
    // Short values
    if (data.length < 80) return <span className="text-emerald-300">{data}</span>
    // Long text
    return <span className="text-zinc-300">{data}</span>
  }

  if (Array.isArray(data)) {
    if (!data.length) return <span className="text-zinc-600">[]</span>
    return (
      <div style={{ paddingLeft: indent ? 12 : 0 }}>
        {data.map((item, i) => (
          <div key={i} className="border-l border-zinc-800 pl-3 ml-1 mb-1.5">
            {typeof item === 'object' && item !== null ? (
              <JsonTree data={item} depth={depth + 1} />
            ) : (
              <span className="text-xs"><JsonTree data={item} depth={depth + 1} /></span>
            )}
          </div>
        ))}
      </div>
    )
  }

  // Object
  const entries = Object.entries(data)
  return (
    <div className="text-xs" style={{ paddingLeft: indent ? 12 : 0 }}>
      {entries.map(([key, val]) => {
        const isNested = val && typeof val === 'object'
        const isCategory = key === 'category' || key === 'function' || key === 'type_group' || key === 'source_feel' || key === 'status'
        return (
          <div key={key} className="mb-0.5">
            <span className="text-zinc-500 font-medium">{key.replace(/_/g, ' ')}: </span>
            {isCategory && typeof val === 'string' ? (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800 text-amber-300 border border-zinc-700">{val}</span>
            ) : isNested ? (
              <JsonTree data={val} depth={depth + 1} keyName={key} />
            ) : (
              <JsonTree data={val} depth={depth + 1} />
            )}
          </div>
        )
      })}
    </div>
  )
}

function OutputSection({ text }) {
  const [mode, setMode] = useState('formatted')
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800">
        <button onClick={() => setMode('formatted')} className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${mode === 'formatted' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}>Output</button>
        <button onClick={() => setMode('raw')} className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${mode === 'raw' ? 'bg-zinc-700 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'}`}>Raw Output</button>
      </div>
      <div className="flex-1 overflow-auto px-4 pb-4 pt-2">
        {mode === 'formatted' ? <FormattedOutput text={text} /> : <pre className="text-xs text-zinc-300 whitespace-pre-wrap">{text || '(no output)'}</pre>}
      </div>
    </div>
  )
}

function LiveSegmentRow({ seg }) {
  const [showOutput, setShowOutput] = useState(false)
  const [copied, setCopied] = useState(false)
  const run = seg.run

  function copyOutput() {
    navigator.clipboard.writeText(run?.output_text || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <div className="pl-14 pr-4 py-1 flex items-center gap-3 text-[10px] border-b border-zinc-800/20 last:border-0">
        <span className="text-zinc-700 w-4 text-right shrink-0">{seg.index + 1}</span>
        <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
          seg.status === 'complete' ? 'bg-emerald-500' :
          seg.status === 'running' ? 'bg-blue-500 animate-pulse' :
          'bg-zinc-700'
        }`} />
        <span className={`flex-1 truncate ${
          seg.status === 'complete' ? 'text-zinc-400' :
          seg.status === 'running' ? 'text-blue-400' :
          'text-zinc-600'
        }`}>
          {seg.label}
          {seg.liveStatus && <span className="text-amber-400/70 ml-1">· {seg.liveStatus}</span>}
        </span>
        {seg.tokens > 0 && <span className="text-zinc-600 shrink-0">{formatTokens(seg.tokens)}</span>}
        {seg.cost > 0 && <span className="text-zinc-600 shrink-0">{formatCost(seg.cost)}</span>}
        {seg.runtime > 0 && <span className="text-zinc-600 shrink-0">{formatRuntime(seg.runtime)}</span>}
        {run && (
          <button onClick={() => setShowOutput(true)} className="text-zinc-600 hover:text-zinc-300 shrink-0">View</button>
        )}
      </div>
      {showOutput && run && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setShowOutput(false)}>
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg max-w-5xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-3 border-b border-zinc-800">
              <span className="text-sm font-medium">{seg.label}</span>
              <div className="flex items-center gap-3">
                {run.model && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">{run.model}</span>}
                <span className="text-[10px] text-zinc-500">{formatTokens(seg.tokens || 0)} tokens · {formatCost(seg.cost || 0)} · {formatRuntime(seg.runtime || 0)}</span>
                <button onClick={copyOutput} className="text-zinc-400 hover:text-white text-xs flex items-center gap-1">
                  {copied ? <><Check size={12} className="text-emerald-400" /> Copied</> : <><Copy size={12} /> Copy</>}
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto flex flex-col">
              {run.system_instruction_used && (
                <details className="border-b border-zinc-800">
                  <summary className="px-4 py-2 text-[10px] font-bold text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-300">System Instructions</summary>
                  <pre className="px-4 pb-3 text-xs text-zinc-500 whitespace-pre-wrap max-h-48 overflow-auto">{run.system_instruction_used}</pre>
                </details>
              )}
              {run.prompt_used && (
                <details className="border-b border-zinc-800">
                  <summary className="px-4 py-2 text-[10px] font-bold text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-300">Prompt</summary>
                  <pre className="px-4 pb-3 text-xs text-zinc-500 whitespace-pre-wrap max-h-48 overflow-auto">{run.prompt_used}</pre>
                </details>
              )}
              {run.input_text && (
                <details className="border-b border-zinc-800">
                  <summary className="px-4 py-2 text-[10px] font-bold text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-300">Input</summary>
                  <pre className="px-4 pb-3 text-xs text-zinc-500 whitespace-pre-wrap max-h-48 overflow-auto">{run.input_text}</pre>
                </details>
              )}
              <OutputSection text={run.output_text} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function LiveStageRow({ breadcrumb: s, isRunning, pipeline, subRuns = [] }) {
  const [expanded, setExpanded] = useState(isRunning)
  const subTotal = isRunning ? (pipeline.subTotal || 0) : 0
  const subDone = isRunning ? (pipeline.subDone || 0) : 0
  const segmentStatuses = pipeline.segmentStatuses || {}
  const hasSegments = subTotal > 0

  // Build segment list: completed from DB + in-flight (with per-segment status) + pending
  const segments = []
  if (hasSegments) {
    const doneByIndex = {}
    for (const sr of subRuns) {
      doneByIndex[sr._meta.subIndex] = sr
    }
    for (let si = 0; si < subTotal; si++) {
      const done = doneByIndex[si]
      const liveStatus = segmentStatuses[si] // per-segment status from backend
      if (done) {
        segments.push({ index: si, status: 'complete', label: done._meta.subLabel || `Segment ${si + 1}`, tokens: (done.tokens_in || 0) + (done.tokens_out || 0), cost: done.cost, runtime: done.runtime_ms, run: done })
      } else if (liveStatus) {
        // In-flight with live status from backend
        segments.push({ index: si, status: 'running', label: `Segment ${si + 1}`, liveStatus })
      } else if (si < subDone) {
        // Completed but not yet in DB (polling delay)
        segments.push({ index: si, status: 'complete', label: `Segment ${si + 1}` })
      } else {
        segments.push({ index: si, status: 'pending', label: `Segment ${si + 1}` })
      }
    }
  }

  return (
    <>
      <div className={`px-4 py-2 flex items-center gap-3 text-xs border-b border-zinc-800/30 last:border-0 ${isRunning ? 'bg-blue-900/10' : ''}`}>
        {hasSegments ? (
          <button onClick={() => setExpanded(!expanded)} className="text-zinc-500 hover:text-zinc-300 shrink-0 w-4">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="text-zinc-600 w-6 text-right shrink-0">{s.index}</span>
        <StatusBadge status={isRunning ? 'running' : 'pending'} />
        {s.phase && <PhaseBadge phase={s.phase} videoLabel={s.videoLabel} />}
        <span className={`flex-1 truncate ${isRunning ? 'text-blue-400' : 'text-zinc-600'}`}>
          {s.name || `Stage ${s.index + 1}`}
          {hasSegments && <span className="text-zinc-500 ml-1">({subDone}/{subTotal})</span>}
        </span>
      </div>
      {expanded && hasSegments && (
        <div>
          {segments.map(seg => (
            <LiveSegmentRow key={seg.index} seg={seg} />
          ))}
        </div>
      )}
    </>
  )
}

function StageRow({ stage, index, subRuns = [], isSub, pipelineId, setUrlRun, urlShowOutput, onRerunFrom }) {
  const meta = stage._meta || {}
  const stageIdx = meta.stageIndex ?? index
  const [showOutput, setShowOutput] = useState(urlShowOutput || false)
  const [showSubs, setShowSubs] = useState(false)
  const [copied, setCopied] = useState(false)
  const [detail, setDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const hasSubRuns = subRuns.length > 0

  async function toggleOutput() {
    const next = !showOutput
    setShowOutput(next)
    if (setUrlRun && pipelineId) setUrlRun(pipelineId, next ? stageIdx : null)
    // Lazy-fetch heavy fields on first expand
    if (next && !detail && !String(stage.id).startsWith('synthetic-')) {
      setDetailLoading(true)
      try {
        const res = await apiGet(`/broll/runs/${stage.id}/detail`)
        setDetail(res)
      } catch {}
      setDetailLoading(false)
    }
  }

  const fullStage = detail ? { ...stage, ...detail } : stage

  function copyOutput() {
    navigator.clipboard.writeText(fullStage.output_text || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <div className={`px-4 py-2 flex items-center gap-3 text-xs ${isSub ? 'pl-10 bg-zinc-800/20' : 'hover:bg-zinc-800/30'} border-b border-zinc-800/30 last:border-0`}>
        {/* Expand toggle for sub-runs */}
        {hasSubRuns ? (
          <button onClick={() => setShowSubs(!showSubs)} className="text-zinc-500 hover:text-zinc-300 shrink-0 w-4">
            {showSubs ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span className="text-zinc-600 w-6 text-right shrink-0">{meta.stageIndex ?? index}</span>
        <StatusBadge status={stage.status} />
        {meta.phase && <PhaseBadge phase={meta.phase} videoLabel={meta.videoLabel} />}
        <TypeBadge type={meta.stageType || stage.model} />
        <span className="flex-1 truncate text-zinc-300">
          {stage.stage_name || meta.stageName || `Stage ${index}`}
          {hasSubRuns && <span className="text-zinc-600 ml-1">({subRuns.length} sub-runs)</span>}
        </span>
        <span className="text-zinc-500 w-10 text-right">{formatTokens((stage.tokens_in || 0) + (stage.tokens_out || 0))}</span>
        <span className="text-zinc-500 w-14 text-right">{formatCost(stage.cost)}</span>
        <span className="text-zinc-500 w-12 text-right">{formatRuntime(stage.runtime_ms)}</span>
        {onRerunFrom && !isSub && (
          <button
            onClick={(e) => { e.stopPropagation(); onRerunFrom(meta.stageIndex ?? index) }}
            className="text-zinc-600 hover:text-blue-400 shrink-0 p-0.5 rounded hover:bg-blue-900/30 transition-colors"
            title="Re-run from this stage"
          >
            <RotateCcw size={10} />
          </button>
        )}
        <button onClick={toggleOutput} className="text-zinc-500 hover:text-zinc-300 text-[10px] shrink-0">
          {showOutput ? 'Hide' : 'View'}
        </button>
        {showOutput && (
          <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={toggleOutput}>
            <div className="bg-zinc-900 border border-zinc-700 rounded-lg max-w-5xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between p-3 border-b border-zinc-800">
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">{stage.stage_name || meta.stageName}</span>
                  {meta.phase && <PhaseBadge phase={meta.phase} videoLabel={meta.videoLabel} />}
                  <TypeBadge type={meta.stageType || stage.model} />
                </div>
                <div className="flex items-center gap-3">
                  {stage.model && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700">{stage.model}</span>}
                  {(() => { try { const p = JSON.parse(stage.params_json || '{}'); return (p.temperature != null || p.thinking_level) ? <span className="text-[10px] text-zinc-500">{p.temperature != null ? `temp=${p.temperature}` : ''}{p.temperature != null && p.thinking_level ? ' · ' : ''}{p.thinking_level ? `thinking=${p.thinking_level}` : ''}</span> : null } catch { return null } })()}
                  <span className="text-[10px] text-zinc-500">{formatTokens((stage.tokens_in||0)+(stage.tokens_out||0))} tokens · {formatCost(stage.cost)} · {formatRuntime(stage.runtime_ms)}</span>
                  <button onClick={copyOutput} className="text-zinc-400 hover:text-white text-xs flex items-center gap-1">
                    {copied ? <><Check size={12} className="text-emerald-400" /> Copied</> : <><Copy size={12} /> Copy</>}
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto flex flex-col">
                {detailLoading && (
                  <div className="px-4 py-3 text-xs text-zinc-500 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading...</div>
                )}
                {fullStage.input_text && (
                  <details className="border-b border-zinc-800">
                    <summary className="px-4 py-2 text-[10px] font-bold text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-300">Input</summary>
                    <pre className="px-4 pb-3 text-xs text-zinc-500 whitespace-pre-wrap max-h-48 overflow-auto">{fullStage.input_text}</pre>
                  </details>
                )}
                {fullStage.system_instruction_used && (
                  <details className="border-b border-zinc-800">
                    <summary className="px-4 py-2 text-[10px] font-bold text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-300">System Instructions</summary>
                    <pre className="px-4 pb-3 text-xs text-zinc-500 whitespace-pre-wrap max-h-48 overflow-auto">{fullStage.system_instruction_used}</pre>
                  </details>
                )}
                {fullStage.prompt_used && (
                  <details className="border-b border-zinc-800">
                    <summary className="px-4 py-2 text-[10px] font-bold text-zinc-500 uppercase tracking-wider cursor-pointer hover:text-zinc-300">Prompt</summary>
                    <pre className="px-4 pb-3 text-xs text-zinc-500 whitespace-pre-wrap max-h-48 overflow-auto">{fullStage.prompt_used}</pre>
                  </details>
                )}
                <OutputSection text={fullStage.output_text} />
              </div>
            </div>
          </div>
        )}
      </div>
      {/* Nested sub-runs */}
      {showSubs && subRuns.map((sub, i) => (
        <StageRow key={sub.id} stage={sub} index={i} isSub />
      ))}
    </>
  )
}
