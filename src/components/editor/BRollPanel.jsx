import { useState, useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApi, apiPost } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'
import { Play, Loader2, CheckCircle, AlertCircle, RotateCcw, Search, Sparkles, Layers, Tag, Film, Star } from 'lucide-react'
import BRollEditor from './BRollEditor.jsx'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
async function authFetch(path) {
  const headers = {}
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  return fetch(`${API_BASE}${path}`, { headers })
}

function ytThumbnail(url) {
  if (!url) return null
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/)
  return m ? `https://img.youtube.com/vi/${m[1]}/mqdefault.jpg` : null
}

function formatDuration(sec) {
  if (!sec) return '--:--:--'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function BRollPanel({ groupId, videoId, sub, detail }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data: strategies } = useApi('/broll/strategies')
  const { data: videoRunsData, loading: runsLoading, refetch: refetchRuns } = useApi(videoId ? `/broll/runs/video/${videoId}` : null)
  const { data: examples } = useApi(groupId ? `/broll/groups/${groupId}/examples` : null)
  const [runningType, setRunningType] = useState(null) // 'analysis' | 'plan' | null
  const [pipelineId, setPipelineId] = useState(null)
  const [pipelineIds, setPipelineIds] = useState([]) // multiple parallel analysis runs
  const [pipelineProgresses, setPipelineProgresses] = useState({}) // { pipelineId: progress }
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)

  const analysisStrategy = (strategies || []).find(s => s.strategy_kind === 'main_analysis')
  const planStrategy = (strategies || []).find(s => s.strategy_kind === 'plan')
  const altPlanStrategy = (strategies || []).find(s => s.strategy_kind === 'alt_plan')
  const keywordsStrategy = (strategies || []).find(s => s.strategy_kind === 'keywords')
  const planPrepStrategy = (strategies || []).find(s => s.strategy_kind === 'plan_prep')
  const createStrategyKind = (strategies || []).find(s => s.strategy_kind === 'create_strategy')
  const createPlanStrategy = (strategies || []).find(s => s.strategy_kind === 'create_plan')
  const videoRuns = videoRunsData?.runs || []
  const activePipelines = videoRunsData?.activePipelines || []

  // Group runs by pipelineId
  const pipelineMap = {}
  for (const run of videoRuns) {
    try {
      const meta = JSON.parse(run.metadata_json || '{}')
      const pid = meta.pipelineId
      if (!pid) continue
      if (!pipelineMap[pid]) pipelineMap[pid] = { stages: [], status: 'complete', lastRunId: null }
      pipelineMap[pid].stages.push({ ...run, _meta: meta })
      if (run.status === 'failed') pipelineMap[pid].status = 'failed'
      // Track the last (highest stageIndex) run id for reference_run_id
      if (!pipelineMap[pid].lastRunId || (meta.stageIndex || 0) > (pipelineMap[pid].lastStageIndex || 0)) {
        pipelineMap[pid].lastRunId = run.id
        pipelineMap[pid].lastStageIndex = meta.stageIndex || 0
      }
    } catch {}
  }

  // Parse chapters, stats, and patterns per example video from analysis runs
  // pipelineId format: "{strategyId}-{videoId}-{ts}-ex{exampleVideoId}"
  const chaptersByExampleVideo = useMemo(() => {
    const map = {} // { exampleVideoId: { chapters, stats, patterns } }

    function parseOutput(text) {
      const jsonMatch = text?.match(/```json\s*([\s\S]*?)```/)
      if (jsonMatch) { try { return JSON.parse(jsonMatch[1]) } catch {} }
      try { return JSON.parse(text) } catch {}
      return null
    }

    for (const run of videoRuns) {
      if (run.status !== 'complete' || !run.output_text) continue
      const meta = (() => { try { return JSON.parse(run.metadata_json || '{}') } catch { return {} } })()
      const exMatch = meta.pipelineId?.match(/-ex(\d+)$/)
      if (!exMatch) continue
      const exVid = Number(exMatch[1])
      if (!map[exVid]) map[exVid] = { chapters: [], stats: [], patterns: [] }

      if (meta.stageName === 'Analyze A-Roll + Chapters & Beats') {
        const parsed = parseOutput(run.output_text)
        if (parsed?.chapters) map[exVid].chapters = parsed.chapters
      }
      if (meta.stageName === 'Compute chapter stats') {
        const parsed = parseOutput(run.output_text)
        if (Array.isArray(parsed)) map[exVid].stats = parsed
      }
      if (meta.stageName === 'Pattern analysis' && meta.isSubRun) {
        const parsed = parseOutput(run.output_text)
        if (parsed) map[exVid].patterns.push({ subIndex: meta.subIndex, data: parsed })
      }
    }
    // Sort patterns by subIndex
    for (const v of Object.values(map)) {
      v.patterns.sort((a, b) => (a.subIndex || 0) - (b.subIndex || 0))
    }
    return map
  }, [videoRuns])

  // Check for completed analysis (strategy_id matches analysis strategy)
  const completedAnalysis = Object.values(pipelineMap).find(p =>
    p.status === 'complete' && p.stages.some(s => s.strategy_id === analysisStrategy?.id)
  )
  const hasCompletedAnalysis = !!completedAnalysis
  const analysisRunId = completedAnalysis?.lastRunId

  // Check for completed plan
  const hasCompletedPlan = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => s.strategy_id === planStrategy?.id)
  )

  // Check for completed alt plan (runs as part of plan pipeline with alt_plan phase)
  const hasCompletedAltPlan = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => {
      try { return JSON.parse(s.metadata_json || '{}').phase === 'alt_plan' } catch { return false }
    })
  )

  // Check for completed keywords
  const hasCompletedKeywords = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => {
      try { return JSON.parse(s.metadata_json || '{}').phase === 'keywords' } catch { return false }
    })
  )

  // Check for completed B-Roll search
  const hasCompletedBrollSearch = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => {
      try { return JSON.parse(s.metadata_json || '{}').phase === 'broll_search' } catch { return false }
    })
  )

  // Check for completed plan prep
  const hasCompletedPrep = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => {
      try { return JSON.parse(s.metadata_json || '{}').phase === 'plan_prep' } catch { return false }
    })
  )

  // Find completed prep pipeline ID
  const completedPrepPipeline = Object.entries(pipelineMap).find(([pid, p]) =>
    p.status === 'complete' && pid.startsWith('prep-')
  )
  const prepPipelineId = completedPrepPipeline?.[0] || null

  // Find completed analysis pipeline IDs
  const completedAnalysisPipelineIds = Object.entries(pipelineMap)
    .filter(([pid, p]) => p.status === 'complete' && p.stages.some(s => s.strategy_id === analysisStrategy?.id))
    .map(([pid]) => pid)

  // Check for completed strategies
  const hasCompletedStrategies = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => {
      try { const m = JSON.parse(s.metadata_json || '{}'); return m.phase === 'create_strategy' || m.phase === 'create_combined_strategy' } catch { return false }
    })
  )

  // Find completed strategy pipeline IDs
  const completedStrategyPipelineIds = Object.entries(pipelineMap)
    .filter(([pid, p]) => p.status === 'complete' && (pid.startsWith('strat-') || pid.startsWith('cstrat-')))
    .map(([pid]) => pid)

  // Check for completed plan (new style)
  const hasCompletedNewPlan = Object.values(pipelineMap).some(p =>
    p.status === 'complete' && p.stages.some(s => {
      try { return JSON.parse(s.metadata_json || '{}').phase === 'create_plan' } catch { return false }
    })
  )

  // Find new-style plan pipeline ID for keywords/search
  const completedNewPlanPipeline = Object.entries(pipelineMap).find(([pid, p]) =>
    p.status === 'complete' && pid.startsWith('plan-')
  )
  const newPlanPipelineId = completedNewPlanPipeline?.[0] || null

  const hasActivePipeline = activePipelines.length > 0
  const activeProgress = activePipelines[0] || null

  // If there are active pipelines on mount (started externally), track them
  useEffect(() => {
    if (!activePipelines.length || pipelineId || pipelineIds.length) return

    // Check for parallel analysis runs (multiple pipelines with exampleVideoId)
    const activeAnalysis = activePipelines.filter(p => p.status === 'running' && String(p.strategyId) === String(analysisStrategy?.id))
    if (activeAnalysis.length > 1 || (activeAnalysis.length === 1 && activeAnalysis[0].exampleVideoId)) {
      setPipelineIds(activeAnalysis.map(p => p.pipelineId))
      setRunningType('analysis')
      // Seed initial progress
      const initial = {}
      for (const p of activeAnalysis) initial[p.pipelineId] = p
      setPipelineProgresses(initial)
      return
    }

    // Single active pipeline
    if (activeProgress) {
      setPipelineId(activeProgress.pipelineId)
      setRunningType(activeProgress.phase === 'alt_plan' ? 'alt_plan' : String(activeProgress.strategyId) === String(analysisStrategy?.id) ? 'analysis' : 'plan')
      setProgress(activeProgress)
    }
  }, [activePipelines, pipelineId, pipelineIds.length, analysisStrategy?.id])

  // Poll progress
  useEffect(() => {
    if (!pipelineId || !runningType) return
    const interval = setInterval(async () => {
      try {
        const res = await authFetch(`/broll/pipeline/${pipelineId}/progress`)
        const data = await res.json()
        setProgress(data)
        if (data.status === 'complete' || data.status === 'failed') {
          setRunningType(null)
          setPipelineId(null)
          if (data.status === 'failed') setError(data.error || 'Pipeline failed')
          refetchRuns()
        }
      } catch {}
    }, 3000)
    return () => clearInterval(interval)
  }, [pipelineId, runningType, refetchRuns])

  // Poll progress for parallel analysis runs
  useEffect(() => {
    if (!pipelineIds.length || !['analysis', 'strategy'].includes(runningType)) return
    const interval = setInterval(async () => {
      try {
        const updates = {}
        for (const pid of pipelineIds) {
          const res = await authFetch(`/broll/pipeline/${pid}/progress`)
          updates[pid] = await res.json()
        }
        setPipelineProgresses(updates)

        const allDone = Object.values(updates).every(p => p.status === 'complete' || p.status === 'failed')
        if (allDone) {
          setRunningType(null)
          setPipelineIds([])
          setPipelineProgresses({})
          const failed = Object.values(updates).filter(p => p.status === 'failed')
          if (failed.length) setError(`${failed.length} analysis run(s) failed: ${failed.map(p => p.error).join('; ')}`)
          refetchRuns()
        }
      } catch {}
    }, 3000)
    return () => clearInterval(interval)
  }, [pipelineIds, runningType, refetchRuns])

  async function getLatestVersion(strategyId) {
    const res = await authFetch(`/broll/strategies/${strategyId}/versions`)
    const versions = await res.json()
    if (!versions?.[0]) throw new Error('No strategy version found')
    return versions[0]
  }

  async function handleRunAnalysis() {
    if (!videoId || !groupId) return
    setRunningType('analysis')
    setError(null)
    setProgress(null)
    setPipelineIds([])
    setPipelineProgresses({})
    try {
      const res = await apiPost('/broll/pipeline/run-all', {
        video_id: videoId,
        group_id: groupId,
      })
      // Track all pipeline IDs (prep + analyses)
      const allIds = [res.prepPipelineId, ...(res.analysisPipelineIds || [])].filter(Boolean)
      setPipelineIds(allIds)
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  async function handleRunStrategies() {
    if (!prepPipelineId || !completedAnalysisPipelineIds.length || !videoId) return
    setRunningType('strategy')
    setError(null)
    setProgress(null)
    setPipelineIds([])
    setPipelineProgresses({})
    try {
      const res = await apiPost('/broll/pipeline/run-strategies', {
        prep_pipeline_id: prepPipelineId,
        analysis_pipeline_ids: completedAnalysisPipelineIds,
        video_id: videoId,
        group_id: groupId,
      })
      setPipelineIds(res.strategyPipelineIds || [])
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  // Find the completed plan pipeline ID (for resuming keywords/search - old style)
  const completedPlanPipeline = Object.entries(pipelineMap).find(([pid, p]) =>
    p.status === 'complete' && p.stages.some(s => s.strategy_id === planStrategy?.id)
  )
  const planPipelineId = completedPlanPipeline?.[0] || null

  async function handleRunNewPlan() {
    // For now, use the first completed strategy. Later: user picks.
    const stratId = completedStrategyPipelineIds[0]
    if (!prepPipelineId || !stratId || !videoId) return
    setRunningType('plan')
    setError(null)
    setProgress(null)
    setPipelineIds([])
    setPipelineProgresses({})
    try {
      const res = await apiPost('/broll/pipeline/run-plan', {
        prep_pipeline_id: prepPipelineId,
        strategy_pipeline_id: stratId,
        video_id: videoId,
        group_id: groupId,
      })
      if (res.planPipelineId) setPipelineId(res.planPipelineId)
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  async function handleRunKeywords() {
    const kwPipelineId = newPlanPipelineId || planPipelineId
    if (!kwPipelineId) return
    setRunningType('keywords')
    setError(null)
    setProgress(null)
    try {
      await apiPost(`/broll/pipeline/${kwPipelineId}/run-keywords`, {})
      refetchRuns()
      setTimeout(() => refetchRuns(), 2000)
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  const isRunning = !!runningType

  // URL-based sub-routing for brolls
  // Redirect bare /brolls to /brolls/strategy or /brolls/edit based on state
  useEffect(() => {
    if (runsLoading) return
    if (!sub) {
      if (hasCompletedBrollSearch) {
        navigate(`/editor/${id}/brolls/edit`, { replace: true })
      } else {
        navigate(`/editor/${id}/brolls/strategy`, { replace: true })
      }
    }
    // Redirect old numeric placement URLs (e.g. /brolls/5) to /brolls/edit/5
    if (sub && sub !== 'strategy' && sub !== 'edit' && !isNaN(Number(sub))) {
      navigate(`/editor/${id}/brolls/edit/${sub}`, { replace: true })
    }
  }, [sub, runsLoading, hasCompletedBrollSearch, id, navigate])

  // Show B-Roll editor when sub === 'edit'
  if (sub === 'edit') {
    return <BRollEditor groupId={groupId} videoId={videoId} planPipelineId={newPlanPipelineId || planPipelineId} />
  }

  // Show loading while checking if steps are already complete (prevents flash of steps UI)
  if (runsLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={24} className="text-primary-fixed animate-spin" />
      </div>
    )
  }

  const refVideos = examples || []

  // Pipeline step config
  const isAnalysisDone = hasCompletedAnalysis && hasCompletedPrep
  const isStrategyDone = hasCompletedStrategies
  const isPlanDone = hasCompletedNewPlan || hasCompletedPlan
  const kwPipelineId = newPlanPipelineId || planPipelineId

  const steps = [
    { key: 'analysis', label: 'Analyze & Prepare', icon: Search, done: isAnalysisDone, enabled: true, handler: handleRunAnalysis, running: runningType === 'analysis' },
    { key: 'strategy', label: 'Generate Strategies', icon: Layers, done: isStrategyDone, enabled: isAnalysisDone, handler: handleRunStrategies, running: runningType === 'strategy' },
    { key: 'plan', label: 'Generate Plan', icon: Sparkles, done: isPlanDone, enabled: isStrategyDone, handler: handleRunNewPlan, running: runningType === 'plan' },
    { key: 'keywords', label: 'Keywords', icon: Tag, done: hasCompletedKeywords, enabled: isPlanDone, handler: handleRunKeywords, running: runningType === 'keywords' },
    { key: 'search', label: 'Search B-Roll', icon: Film, done: hasCompletedBrollSearch, enabled: hasCompletedKeywords, handler: () => navigate(`/editor/${id}/brolls/edit`) },
  ]

  return (
    <div className="flex-1 overflow-auto">
      <div className="px-8 pt-8 pb-12">
        {/* Header */}
        <header className="mb-8">
          <div className="flex items-center gap-2 text-[#cefc00] mb-3">
            <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>auto_awesome</span>
            <span className="text-[10px] font-bold uppercase tracking-[0.2em]">B-Roll Strategy</span>
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-zinc-100">Step 1: Reference Analysis</h1>
        </header>

        {/* Pipeline Steps Bar */}
        <div className="flex items-center gap-1 mb-8 bg-zinc-900 rounded-xl p-2">
          {steps.map((step, i) => {
            const Icon = step.icon
            const isActive = step.running
            return (
              <button
                key={step.key}
                onClick={step.handler}
                disabled={isRunning || !step.enabled}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex-1 justify-center disabled:opacity-30 ${
                  step.done
                    ? 'bg-[#cefc00]/10 text-[#cefc00]'
                    : isActive
                    ? 'bg-zinc-800 text-blue-400'
                    : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
                }`}
              >
                {isActive ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : step.done ? (
                  <CheckCircle size={12} />
                ) : (
                  <Icon size={12} />
                )}
                {step.label}
              </button>
            )
          })}
        </div>

        {/* Progress card — single run */}
        {isRunning && progress && !pipelineIds.length && (() => {
          const pct = progress.totalStages > 0 ? Math.round((progress.stageIndex / progress.totalStages) * 100) : 0
          return (
            <div className="bg-zinc-900 rounded-xl p-5 mb-8 border border-zinc-800/50">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Loader2 size={14} className="text-[#cefc00] animate-spin" />
                  <span className="text-sm text-zinc-200 font-semibold">{progress.stageName || 'Processing...'}</span>
                </div>
                <span className="text-sm font-black text-[#cefc00]">{pct}%</span>
              </div>
              <div className="h-1.5 w-full bg-zinc-950 rounded-full overflow-hidden mb-2">
                <div className="h-full bg-[#cefc00] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-[10px] text-zinc-500 font-mono">
                Stage {(progress.stageIndex || 0) + 1} of {progress.totalStages}
                {progress.subTotal ? ` — ${progress.subLabel || ''} (${progress.subDone || 0}/${progress.subTotal})` : ''}
                {progress.gpuStage ? ` · GPU: ${progress.gpuStage}${progress.gpuStatus ? ` (${progress.gpuStatus})` : ''}` : ''}
              </div>
            </div>
          )
        })()}

        {/* Error */}
        {error && !isRunning && (
          <div className="bg-red-950/30 border border-red-900/50 rounded-xl p-4 flex items-start gap-2 mb-8">
            <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
            <div className="text-sm text-red-300">{error}</div>
          </div>
        )}

        {/* Reference Video Cards */}
        <section className="space-y-6">
          {refVideos.length === 0 && (
            <div className="bg-zinc-900 rounded-xl p-12 text-center border border-zinc-800/30">
              <span className="material-symbols-outlined text-4xl text-zinc-700 mb-3 block">video_library</span>
              <p className="text-zinc-500 text-sm">No reference videos added yet.</p>
              <p className="text-zinc-600 text-xs mt-1">Add reference videos in the project setup to analyze their b-roll patterns.</p>
            </div>
          )}

          {refVideos.map((source, sourceIdx) => {
            const thumb = ytThumbnail(source.source_url)
            const duration = source.duration_seconds
            const isReady = source.status === 'ready'
            const isFav = source.is_favorite

            // Per-source analysis status — match by exampleVideoId from pipeline progress
            const sourceVideoId = (() => { try { return JSON.parse(source.meta_json || '{}').videoId } catch { return null } })()
            const sourceProgress = Object.values(pipelineProgresses).find(p => p.exampleVideoId === sourceVideoId)
              || (pipelineIds[sourceIdx] ? pipelineProgresses[pipelineIds[sourceIdx]] : null)
            const sourceAnalysisDone = sourceProgress?.status === 'complete' || hasCompletedAnalysis
            const sourceAnalysisRunning = sourceProgress && sourceProgress.status === 'running'
            const sourceAnalysisPct = sourceProgress?.totalStages > 0
              ? Math.round(((sourceProgress.stageIndex || sourceProgress.completedStages || 0) / sourceProgress.totalStages) * 100)
              : 0

            return (
              <div key={source.id} className="bg-zinc-900 rounded-xl overflow-hidden flex flex-col md:flex-row group transition-all">
                {/* Thumbnail — compact */}
                <div className="md:w-1/5 relative overflow-hidden aspect-video md:aspect-auto min-h-[140px]">
                  {thumb ? (
                    <img src={thumb} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700" />
                  ) : (
                    <div className="w-full h-full bg-zinc-950 flex items-center justify-center">
                      <span className="material-symbols-outlined text-zinc-800 text-5xl">smart_display</span>
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-transparent" />
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent to-zinc-900/40" />
                  {/* Video name */}
                  <div className="absolute top-3 left-3 right-3">
                    <p className="text-xs font-bold text-white truncate drop-shadow-md">{source.label || source.video_title || 'Reference Video'}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-mono text-[10px] text-zinc-300">{formatDuration(duration)}</span>
                      <span className="text-zinc-600">·</span>
                      <span className="text-[10px] text-zinc-400">{source.source_url ? 'YouTube' : 'Upload'}</span>
                    </div>
                  </div>
                  {/* Favorite / Alt badge */}
                  <div className={`absolute bottom-3 left-3 backdrop-blur px-2.5 py-1 rounded flex items-center gap-1.5 ${
                    isFav ? 'bg-[#cefc00]/20' : 'bg-zinc-950/80'
                  }`}>
                    {isFav && <Star size={10} className="text-[#cefc00] fill-[#cefc00]" />}
                    <span className={`text-[9px] font-bold uppercase tracking-wider ${isFav ? 'text-[#cefc00]' : 'text-zinc-500'}`}>
                      {isFav ? 'Primary Reference' : 'Alt Reference'}
                    </span>
                  </div>
                </div>

                {/* Details */}
                <div className="md:w-4/5 p-6 flex flex-col justify-between">
                  <div>

                    {/* Chapters & Beats with stats and patterns */}
                    {(() => {
                      const analysis = chaptersByExampleVideo[sourceVideoId]
                      if (!analysis?.chapters?.length) return null
                      const { stats, patterns } = analysis
                      return (
                        <div>
                          <h3 className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mb-2">
                            Detected Chapters ({analysis.chapters.length})
                          </h3>
                          <div className="space-y-3 max-h-[500px] overflow-y-auto pr-1">
                            {analysis.chapters.map((ch, ci) => {
                              const chStats = stats?.find(s => s.chapter_name === ch.name) || stats?.[ci]
                              const chPattern = patterns?.[ci]?.data
                              const brollPerMin = chStats?.broll?.count && chStats?.duration_seconds
                                ? (chStats.broll.count / (chStats.duration_seconds / 60)).toFixed(1)
                                : null
                              return (
                                <div key={ci} className="bg-zinc-950/50 rounded-lg p-3">
                                  {/* Chapter header + stats */}
                                  <div className="flex items-start justify-between gap-3 mb-2">
                                    <p className="text-zinc-200 font-bold text-xs">
                                      {ch.name} <span className="font-mono text-[#cefc00] font-normal text-[10px]">{ch.start || ch.start_tc || (ch.start_seconds != null ? formatDuration(ch.start_seconds) : '')}</span>
                                    </p>
                                    {chStats?.broll && (
                                      <div className="flex gap-3 shrink-0">
                                        {brollPerMin && (
                                          <div className="text-right">
                                            <p className="text-[9px] text-zinc-600 uppercase">B-rolls</p>
                                            <p className="text-xs font-mono text-[#cefc00]">{brollPerMin}/min</p>
                                          </div>
                                        )}
                                        {chStats.broll.avg_duration_seconds && (
                                          <div className="text-right">
                                            <p className="text-[9px] text-zinc-600 uppercase">Avg dur.</p>
                                            <p className="text-xs font-mono text-zinc-300">{chStats.broll.avg_duration_seconds}s</p>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                  {ch.description && <p className="text-zinc-400 text-xs leading-relaxed flex items-start gap-1.5"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '12px', marginTop: '2px' }}>description</span>{ch.description}</p>}
                                  {ch.purpose && <p className="text-zinc-500 text-[11px] italic mb-2 flex items-start gap-1.5"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>target</span>{ch.purpose}</p>}

                                  {/* Beats with emotion + per-beat strategies */}
                                  {ch.beats?.length > 0 && (
                                    <div className="mt-2 space-y-2.5">
                                      <p className="text-[9px] text-[#c180ff] font-bold uppercase">Beats ({ch.beats.length})</p>
                                      {ch.beats.map((beat, bi) => {
                                        // Match beat_strategies from pattern analysis by name
                                        const beatStrategy = chPattern?.beat_strategies?.find(bs =>
                                          bs.beat_name?.toLowerCase() === beat.name?.toLowerCase()
                                        )
                                        const emotion = beatStrategy?.beat_emotion || beat.emotion
                                        return (
                                          <div key={bi} className="border-l-2 border-zinc-800 pl-3">
                                            <p className="text-zinc-300 text-[11px] font-medium">
                                              {beat.name} <span className="font-mono text-zinc-600 font-normal text-[10px]">{beat.start || beat.start_tc || (beat.start_seconds != null ? formatDuration(beat.start_seconds) : '')}</span>
                                            </p>
                                            {beat.description && <p className="text-zinc-500 text-[11px] leading-relaxed flex items-start gap-1"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>description</span>{beat.description}</p>}
                                            {beat.purpose && <p className="text-zinc-500 text-[11px] italic flex items-start gap-1"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>target</span>{beat.purpose}</p>}
                                            {emotion && <p className="text-zinc-500 text-[11px] flex items-start gap-1"><span className="material-symbols-outlined text-[#cefc00] shrink-0 leading-none" style={{ fontSize: '11px', marginTop: '2px' }}>mood</span>{emotion}</p>}
                                            {beatStrategy?.strategy_points?.length > 0 && (
                                              <ul className="mt-1 space-y-0.5">
                                                {beatStrategy.strategy_points.map((sp, si) => (
                                                  <li key={si} className="text-zinc-400 text-[11px] leading-relaxed flex gap-1.5">
                                                    <span className="text-[#cefc00]/50 shrink-0 mt-0.5">-</span>
                                                    <span>{sp}</span>
                                                  </li>
                                                ))}
                                              </ul>
                                            )}
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })()}

                  </div>

                  {/* Progress bar */}
                  <div className="mt-5">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-[10px] text-zinc-500 font-bold uppercase">Analysis Status</span>
                      <span className={`text-[10px] font-bold ${sourceAnalysisDone ? 'text-[#cefc00]' : sourceAnalysisRunning ? 'text-blue-400' : 'text-zinc-500 italic'}`}>
                        {sourceAnalysisDone ? '100% COMPLETE' : sourceAnalysisRunning ? `${sourceAnalysisPct}% PROCESSING` : 'NOT STARTED'}
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-zinc-950 rounded-full overflow-hidden">
                      {sourceAnalysisDone ? (
                        <div className="h-full bg-[#cefc00] w-full" />
                      ) : sourceAnalysisRunning ? (
                        <div className="h-full bg-blue-400 transition-all" style={{ width: `${Math.max(sourceAnalysisPct, 5)}%` }} />
                      ) : (
                        <div className="h-full bg-zinc-800 w-0" />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}
