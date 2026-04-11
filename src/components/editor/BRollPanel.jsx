import { useState, useEffect } from 'react'
import { useApi, apiPost } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'
import { Play, Loader2, CheckCircle, AlertCircle, RotateCcw, Search, Sparkles, Layers, Tag, Film } from 'lucide-react'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
async function authFetch(path) {
  const headers = {}
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  return fetch(`${API_BASE}${path}`, { headers })
}

export default function BRollPanel({ groupId, videoId }) {
  const { data: strategies } = useApi('/broll/strategies')
  const { data: videoRunsData, refetch: refetchRuns } = useApi(videoId ? `/broll/runs/video/${videoId}` : null)
  const [runningType, setRunningType] = useState(null) // 'analysis' | 'plan' | null
  const [pipelineId, setPipelineId] = useState(null)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)

  const analysisStrategy = (strategies || []).find(s => s.strategy_kind === 'main_analysis')
  const planStrategy = (strategies || []).find(s => s.strategy_kind === 'plan')
  const altPlanStrategy = (strategies || []).find(s => s.strategy_kind === 'alt_plan')
  const keywordsStrategy = (strategies || []).find(s => s.strategy_kind === 'keywords')
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

  const hasActivePipeline = activePipelines.length > 0
  const activeProgress = activePipelines[0] || null

  // If there's an active pipeline on mount, track it
  useEffect(() => {
    if (activeProgress && !pipelineId) {
      setPipelineId(activeProgress.pipelineId)
      setRunningType(activeProgress.phase === 'alt_plan' ? 'alt_plan' : activeProgress.strategyId === analysisStrategy?.id ? 'analysis' : 'plan')
      setProgress(activeProgress)
    }
  }, [activeProgress, pipelineId, analysisStrategy?.id])

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

  async function getLatestVersion(strategyId) {
    const res = await authFetch(`/broll/strategies/${strategyId}/versions`)
    const versions = await res.json()
    if (!versions?.[0]) throw new Error('No strategy version found')
    return versions[0]
  }

  async function handleRunAnalysis() {
    if (!analysisStrategy || !videoId) return
    setRunningType('analysis')
    setError(null)
    setProgress(null)
    try {
      const version = await getLatestVersion(analysisStrategy.id)
      const res = await apiPost(`/broll/strategies/${analysisStrategy.id}/versions/${version.id}/run`, {
        video_id: videoId,
        group_id: groupId,
        transcript_source: 'raw',
      })
      setPipelineId(res.pipelineId)
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  async function handleRunPlan() {
    if (!planStrategy || !videoId || !analysisRunId) return
    setRunningType('plan')
    setError(null)
    setProgress(null)
    try {
      const version = await getLatestVersion(planStrategy.id)
      const res = await apiPost(`/broll/strategies/${planStrategy.id}/versions/${version.id}/run`, {
        video_id: videoId,
        group_id: groupId,
        transcript_source: 'raw',
        reference_run_id: analysisRunId,
        stop_after_plan: true,
      })
      setPipelineId(res.pipelineId)
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  // Find the completed plan pipeline ID (for resuming alt plans)
  const completedPlanPipeline = Object.entries(pipelineMap).find(([pid, p]) =>
    p.status === 'complete' && p.stages.some(s => s.strategy_id === planStrategy?.id)
  )
  const planPipelineId = completedPlanPipeline?.[0] || null

  async function handleRunAltPlans() {
    if (!planPipelineId) return
    setRunningType('alt_plan')
    setError(null)
    setProgress(null)
    try {
      await apiPost(`/broll/pipeline/${planPipelineId}/run-alt-plans`, {})
      refetchRuns()
      setTimeout(() => refetchRuns(), 2000)
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  async function handleRunKeywords() {
    if (!planPipelineId) return
    setRunningType('keywords')
    setError(null)
    setProgress(null)
    try {
      await apiPost(`/broll/pipeline/${planPipelineId}/run-keywords`, {})
      refetchRuns()
      setTimeout(() => refetchRuns(), 2000)
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  async function handleRunBrollSearch() {
    if (!planPipelineId) return
    setRunningType('broll_search')
    setError(null)
    setProgress(null)
    try {
      await apiPost(`/broll/pipeline/${planPipelineId}/run-broll-search`, {})
      refetchRuns()
      setTimeout(() => refetchRuns(), 2000)
    } catch (err) {
      setError(err.message)
      setRunningType(null)
    }
  }

  const isRunning = !!runningType

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">B-Roll</h2>
          <p className="text-sm text-on-surface-variant mt-1">
            Analyze reference videos, then generate a B-Roll placement plan.
          </p>
        </div>

        {/* Progress card */}
        {isRunning && progress && (() => {
          const pct = progress.totalStages > 0 ? Math.round((progress.stageIndex / progress.totalStages) * 100) : 0
          return (
            <div className="bg-surface-variant/20 border border-blue-800/30 rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Loader2 size={14} className="text-primary-fixed animate-spin" />
                  <span className="text-sm text-on-surface">{progress.stageName || 'Processing...'}</span>
                </div>
                <span className="text-sm font-bold text-primary-fixed">{pct}%</span>
              </div>
              <div className="w-full bg-surface-variant/50 rounded-full h-1.5">
                <div className="bg-primary-fixed h-1.5 rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="text-xs text-on-surface-variant">
                Stage {(progress.stageIndex || 0) + 1} of {progress.totalStages}
                {progress.subTotal ? ` — ${progress.subLabel || ''} (${progress.subDone || 0}/${progress.subTotal})` : ''}
                {progress.subStatus ? ` · ${progress.subStatus}` : ''}
              </div>
            </div>
          )
        })()}

        {/* Error */}
        {error && !isRunning && (
          <div className="bg-error-container/20 border border-error/30 rounded-lg p-4 flex items-start gap-2">
            <AlertCircle size={16} className="text-error shrink-0 mt-0.5" />
            <div className="text-sm text-error">{error}</div>
          </div>
        )}

        {/* Step 1: Analysis */}
        <div className={`rounded-xl border p-5 space-y-3 ${hasCompletedAnalysis ? 'border-emerald-800/30 bg-emerald-900/10' : 'border-outline-variant/20 bg-surface-variant/10'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${hasCompletedAnalysis ? 'bg-emerald-900/30' : 'bg-surface-variant/30'}`}>
                <Search size={16} className={hasCompletedAnalysis ? 'text-emerald-400' : 'text-on-surface-variant'} />
              </div>
              <div>
                <div className="text-sm font-semibold text-on-surface">Step 1: Analyze Reference Videos</div>
                <div className="text-xs text-on-surface-variant">
                  {analysisStrategy?.name || 'No analysis strategy configured'}
                </div>
              </div>
            </div>
            {hasCompletedAnalysis ? (
              <div className="flex items-center gap-2">
                <CheckCircle size={14} className="text-emerald-400" />
                <span className="text-xs text-emerald-400 font-medium">Complete</span>
                <button
                  onClick={handleRunAnalysis}
                  disabled={isRunning}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-on-surface-variant hover:text-on-surface bg-surface-variant/30 hover:bg-surface-variant/50 transition-colors disabled:opacity-40"
                >
                  <RotateCcw size={12} />
                  Re-run
                </button>
              </div>
            ) : (
              <button
                onClick={handleRunAnalysis}
                disabled={isRunning || !analysisStrategy}
                className="flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 disabled:opacity-40 transition-all"
              >
                {runningType === 'analysis' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {runningType === 'analysis' ? 'Running...' : 'Run Analysis'}
              </button>
            )}
          </div>
        </div>

        {/* Step 2: Plan */}
        <div className={`rounded-xl border p-5 space-y-3 ${hasCompletedPlan ? 'border-emerald-800/30 bg-emerald-900/10' : !hasCompletedAnalysis ? 'border-outline-variant/10 bg-surface-variant/5 opacity-50' : 'border-outline-variant/20 bg-surface-variant/10'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${hasCompletedPlan ? 'bg-emerald-900/30' : 'bg-surface-variant/30'}`}>
                <Sparkles size={16} className={hasCompletedPlan ? 'text-emerald-400' : 'text-on-surface-variant'} />
              </div>
              <div>
                <div className="text-sm font-semibold text-on-surface">Step 2: Generate B-Roll Plan</div>
                <div className="text-xs text-on-surface-variant">
                  {planStrategy?.name || 'No plan strategy configured'}
                  {!hasCompletedAnalysis && ' — complete analysis first'}
                </div>
              </div>
            </div>
            {hasCompletedPlan ? (
              <div className="flex items-center gap-2">
                <CheckCircle size={14} className="text-emerald-400" />
                <span className="text-xs text-emerald-400 font-medium">Complete</span>
                <button
                  onClick={handleRunPlan}
                  disabled={isRunning || !hasCompletedAnalysis}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-on-surface-variant hover:text-on-surface bg-surface-variant/30 hover:bg-surface-variant/50 transition-colors disabled:opacity-40"
                >
                  <RotateCcw size={12} />
                  Re-run
                </button>
              </div>
            ) : (
              <button
                onClick={handleRunPlan}
                disabled={isRunning || !hasCompletedAnalysis || !planStrategy}
                className="flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 disabled:opacity-40 transition-all"
              >
                {runningType === 'plan' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {runningType === 'plan' ? 'Running...' : 'Generate Plan'}
              </button>
            )}
          </div>
        </div>

        {/* Step 3: Alternative Plans */}
        <div className={`rounded-xl border p-5 space-y-3 ${hasCompletedAltPlan ? 'border-emerald-800/30 bg-emerald-900/10' : !hasCompletedPlan ? 'border-outline-variant/10 bg-surface-variant/5 opacity-50' : 'border-outline-variant/20 bg-surface-variant/10'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${hasCompletedAltPlan ? 'bg-emerald-900/30' : 'bg-surface-variant/30'}`}>
                <Layers size={16} className={hasCompletedAltPlan ? 'text-emerald-400' : 'text-on-surface-variant'} />
              </div>
              <div>
                <div className="text-sm font-semibold text-on-surface">Step 3: Create Alternative Plans</div>
                <div className="text-xs text-on-surface-variant">
                  {altPlanStrategy?.name || 'No alt plan strategy configured'}
                  {!hasCompletedPlan && ' — complete plan first'}
                </div>
              </div>
            </div>
            {hasCompletedAltPlan ? (
              <div className="flex items-center gap-2">
                <CheckCircle size={14} className="text-emerald-400" />
                <span className="text-xs text-emerald-400 font-medium">Complete</span>
                <button
                  onClick={handleRunAltPlans}
                  disabled={isRunning}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-on-surface-variant hover:text-on-surface bg-surface-variant/30 hover:bg-surface-variant/50 transition-colors disabled:opacity-40"
                >
                  <RotateCcw size={12} />
                  Re-run
                </button>
              </div>
            ) : (
              <button
                onClick={handleRunAltPlans}
                disabled={isRunning || !hasCompletedPlan || !planPipelineId}
                className="flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 disabled:opacity-40 transition-all"
              >
                {runningType === 'alt_plan' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {runningType === 'alt_plan' ? 'Running...' : 'Generate Alt Plans'}
              </button>
            )}
          </div>
        </div>

        {/* Step 4: Keywords */}
        <div className={`rounded-xl border p-5 space-y-3 ${hasCompletedKeywords ? 'border-emerald-800/30 bg-emerald-900/10' : !hasCompletedPlan ? 'border-outline-variant/10 bg-surface-variant/5 opacity-50' : 'border-outline-variant/20 bg-surface-variant/10'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${hasCompletedKeywords ? 'bg-emerald-900/30' : 'bg-surface-variant/30'}`}>
                <Tag size={16} className={hasCompletedKeywords ? 'text-emerald-400' : 'text-on-surface-variant'} />
              </div>
              <div>
                <div className="text-sm font-semibold text-on-surface">Step 4: Generate Search Keywords</div>
                <div className="text-xs text-on-surface-variant">
                  {keywordsStrategy?.name || 'B-Roll Search Keywords'}
                  {!hasCompletedPlan && ' — complete plan first'}
                </div>
              </div>
            </div>
            {hasCompletedKeywords ? (
              <div className="flex items-center gap-2">
                <CheckCircle size={14} className="text-emerald-400" />
                <span className="text-xs text-emerald-400 font-medium">Complete</span>
                <button
                  onClick={handleRunKeywords}
                  disabled={isRunning}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-on-surface-variant hover:text-on-surface bg-surface-variant/30 hover:bg-surface-variant/50 transition-colors disabled:opacity-40"
                >
                  <RotateCcw size={12} />
                  Re-run
                </button>
              </div>
            ) : (
              <button
                onClick={handleRunKeywords}
                disabled={isRunning || !hasCompletedPlan || !planPipelineId}
                className="flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 disabled:opacity-40 transition-all"
              >
                {runningType === 'keywords' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {runningType === 'keywords' ? 'Running...' : 'Generate Keywords'}
              </button>
            )}
          </div>
        </div>

        {/* Step 5: B-Roll Video Search */}
        <div className={`rounded-xl border p-5 space-y-3 ${hasCompletedBrollSearch ? 'border-emerald-800/30 bg-emerald-900/10' : !hasCompletedKeywords ? 'border-outline-variant/10 bg-surface-variant/5 opacity-50' : 'border-outline-variant/20 bg-surface-variant/10'}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${hasCompletedBrollSearch ? 'bg-emerald-900/30' : 'bg-surface-variant/30'}`}>
                <Film size={16} className={hasCompletedBrollSearch ? 'text-emerald-400' : 'text-on-surface-variant'} />
              </div>
              <div>
                <div className="text-sm font-semibold text-on-surface">Step 5: Search Stock Footage</div>
                <div className="text-xs text-on-surface-variant">
                  Search Pexels & Storyblocks for each placement (~90s/element)
                  {!hasCompletedKeywords && ' — generate keywords first'}
                </div>
              </div>
            </div>
            {hasCompletedBrollSearch ? (
              <div className="flex items-center gap-2">
                <CheckCircle size={14} className="text-emerald-400" />
                <span className="text-xs text-emerald-400 font-medium">Complete</span>
                <button
                  onClick={handleRunBrollSearch}
                  disabled={isRunning}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold text-on-surface-variant hover:text-on-surface bg-surface-variant/30 hover:bg-surface-variant/50 transition-colors disabled:opacity-40"
                >
                  <RotateCcw size={12} />
                  Re-run
                </button>
              </div>
            ) : (
              <button
                onClick={handleRunBrollSearch}
                disabled={isRunning || !hasCompletedKeywords || !planPipelineId}
                className="flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 disabled:opacity-40 transition-all"
              >
                {runningType === 'broll_search' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {runningType === 'broll_search' ? 'Searching...' : 'Search B-Roll'}
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  )
}
