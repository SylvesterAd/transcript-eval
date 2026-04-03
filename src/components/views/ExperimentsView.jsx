import { useState, useRef, useEffect, useCallback } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi, apiPost, apiDelete } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
async function authFetch(path, opts = {}) {
  const headers = { ...opts.headers }
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  return fetch(`${API_BASE}${path}`, { ...opts, headers })
}
import { previewAugmentedSystem, updateSegmentRulesInSystem, stripSegmentRules } from '../../lib/promptPreview.js'
import { Brain, Play, Plus, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Loader2, BarChart3, Trash2, Bot, Layers, Cpu, Sparkles, MessageSquare, MessageCircleQuestion, Check, RotateCcw, Send, ArrowUp, ArrowDown, X, Copy } from 'lucide-react'

const MODEL_OPTIONS = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'gemini' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', provider: 'gemini' },
  { id: 'gpt-5.4', label: 'GPT 5.4', provider: 'openai' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4.6', provider: 'anthropic' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4.6', provider: 'anthropic' },
]

const THINKING_LEVELS = ['OFF', 'LOW', 'MEDIUM', 'HIGH']

const SEGMENT_PRESETS = {
  short:  { label: 'Short (40–60s)',   minSeconds: 40,  maxSeconds: 60,  contextSeconds: 30 },
  medium: { label: 'Medium (60–100s)', minSeconds: 60,  maxSeconds: 100, contextSeconds: 30 },
  long:   { label: 'Long (100–130s)',  minSeconds: 100, maxSeconds: 130, contextSeconds: 30 },
}

export default function ExperimentsView() {
  const { data: experiments, loading, refetch } = useApi('/experiments')
  const [showCreate, setShowCreate] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()

  const expandedId = searchParams.get('experiment') ? Number(searchParams.get('experiment')) : null
  const urlRun = searchParams.get('run') ? Number(searchParams.get('run')) : null
  const urlStage = searchParams.get('stage') != null ? Number(searchParams.get('stage')) : null

  const setExpandedId = (id) => {
    const next = new URLSearchParams()
    if (id) next.set('experiment', id)
    setSearchParams(next, { replace: true })
  }
  const setViewModal = (val, experimentId) => {
    const next = new URLSearchParams()
    const expId = experimentId || expandedId
    if (expId) next.set('experiment', expId)
    if (val) { next.set('run', val.runId); next.set('stage', val.stageIndex) }
    setSearchParams(next, { replace: true })
  }
  const viewModal = (urlRun != null && urlStage != null && expandedId) ? { runId: urlRun, stageIndex: urlStage } : null

  if (loading) return <div className="p-6 text-zinc-500 text-sm">Loading...</div>

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Experiments</h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="flex items-center gap-1 text-sm bg-white text-black hover:bg-zinc-200 px-3 py-1.5 rounded transition-colors font-medium"
        >
          <Play size={14} />
          Start Experiment
        </button>
      </div>

      {showCreate && <CreateExperimentForm onCreated={() => { setShowCreate(false); refetch() }} />}

      {experiments?.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-zinc-500 text-sm">No experiments yet.</p>
          <p className="text-zinc-600 text-xs mt-1">Create a flow first, then start an experiment.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {experiments.map(e => (
            <ExperimentCard
              key={e.id}
              experiment={e}
              expanded={expandedId === e.id}
              onToggle={() => setExpandedId(expandedId === e.id ? null : e.id)}
              onRefetch={refetch}
              viewModal={expandedId === e.id ? viewModal : null}
              setViewModal={setViewModal}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ExperimentCard({ experiment, expanded, onToggle, onRefetch, viewModal, setViewModal }) {
  const { data: detail, refetch: refetchDetail } = useApi(expanded ? `/experiments/${experiment.id}` : null, [expanded])
  const { data: allVideos } = useApi(expanded ? '/videos' : null, [expanded])
  const [executing, setExecuting] = useState(false)
  const [aborting, setAborting] = useState(false)
  const [progress, setProgress] = useState(null)
  const [execError, setExecError] = useState(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisResult, setAnalysisResult] = useState(null)
  const [showFlow, setShowFlow] = useState(false)
  const [showVideoSelect, setShowVideoSelect] = useState(false)
  const pollRef = useRef(null)

  // Compute selectable videos (collapsed groups)
  const selectableVideos = (() => {
    if (!allVideos) return []
    const grouped = new Map()
    const ungrouped = []
    for (const v of allVideos) {
      if (v.group_id) {
        if (!grouped.has(v.group_id)) {
          grouped.set(v.group_id, { group_name: v.group_name || `Group ${v.group_id}`, videos: [] })
        }
        grouped.get(v.group_id).videos.push(v)
      } else {
        ungrouped.push(v)
      }
    }
    const items = []
    for (const [groupId, g] of grouped) {
      const rep = g.videos[0]
      items.push({ id: rep.id, title: g.group_name, isGroup: true, groupId, videoCount: g.videos.length, allIds: g.videos.map(v => v.id) })
    }
    for (const v of ungrouped) {
      items.push({ id: v.id, title: v.title, isGroup: false })
    }
    return items
  })()

  // Parse saved video IDs from experiment
  const savedVideoIds = detail?.video_ids_json ? JSON.parse(detail.video_ids_json) : []

  async function updateVideoSelection(newIds) {
    try {
      await apiPost(`/experiments/${experiment.id}/update`, { video_ids: newIds })
      refetchDetail()
      onRefetch()
    } catch (err) {
      alert(err.message)
    }
  }

  function toggleExpVideo(itemId) {
    const item = selectableVideos.find(sv => sv.id === itemId)
    if (!item) return
    const ids = item.isGroup ? item.allIds : [item.id]
    const has = ids.every(id => savedVideoIds.includes(id))
    const newIds = has
      ? savedVideoIds.filter(id => !ids.includes(id))
      : [...savedVideoIds, ...ids.filter(id => !savedVideoIds.includes(id))]
    updateVideoSelection(newIds)
  }

  const startPolling = useCallback(() => {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      try {
        const res = await authFetch(`/experiments/${experiment.id}/progress`)
        const prog = await res.json()
        setProgress(prog)
        if (!prog.active) {
          clearInterval(pollRef.current)
          pollRef.current = null
          setExecuting(false)
          setAborting(false)
          onRefetch()
          if (expanded) refetchDetail()
        }
      } catch { /* ignore */ }
    }, 1500)
  }, [experiment.id, onRefetch, expanded, refetchDetail])

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  useEffect(() => {
    authFetch(`/experiments/${experiment.id}/progress`)
      .then(r => r.json())
      .then(prog => {
        setProgress(prog)
        if (prog.active || prog.running > 0) {
          setExecuting(true)
          startPolling()
        }
      })
      .catch(() => {})
  }, [experiment.id, startPolling])

  async function handleExecute(repeat = 1) {
    setExecuting(true)
    setAborting(false)
    setExecError(null)
    setProgress(null)
    try {
      await apiPost(`/experiments/${experiment.id}/execute`, { repeat })
      startPolling()
    } catch (err) {
      setExecError(err.message)
      setExecuting(false)
    }
  }

  async function handleAbort() {
    setAborting(true)
    try {
      await apiPost(`/experiments/${experiment.id}/abort`)
    } catch { /* ignore */ }
  }

  async function handleRetry() {
    setExecuting(true)
    setExecError(null)
    try {
      await apiPost(`/experiments/${experiment.id}/retry`)
      startPolling()
    } catch (err) {
      setExecError(err.message)
      setExecuting(false)
    }
  }

  async function handleResume() {
    setExecuting(true)
    setExecError(null)
    try {
      await apiPost(`/experiments/${experiment.id}/resume`)
      startPolling()
    } catch (err) {
      setExecError(err.message)
      setExecuting(false)
    }
  }

  const hasFailedRuns = progress?.failed > 0 && !executing
  const hasPartialRuns = (progress?.partial > 0 || experiment.partial_runs > 0) && !executing

  const stages = detail?.stages_json ? JSON.parse(detail.stages_json) : []

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg">
      {/* Header */}
      <div className="p-4 cursor-pointer" onClick={onToggle}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {expanded ? <ChevronDown size={16} className="text-zinc-500" /> : <ChevronRight size={16} className="text-zinc-500" />}
            <div>
              <div className="font-medium">{experiment.name}</div>
              <div className="text-sm text-zinc-400 mt-0.5">
                {experiment.strategy_name} v{experiment.version_number}
                <span className="ml-3 text-zinc-500">{experiment.completed_runs}/{experiment.run_count} runs</span>
                {experiment.partial_runs > 0 && (
                  <span className="ml-2 text-blue-400 text-xs">{experiment.partial_runs} partial</span>
                )}
                {experiment.avg_score !== null && (
                  <span className={`ml-3 font-medium ${scoreColor(experiment.avg_score)}`}>{Math.round(experiment.avg_score * 100)}%</span>
                )}
              </div>
            </div>
          </div>
          <button
            onClick={e => { e.stopPropagation(); if (confirm(`Delete experiment "${experiment.name}" and all its runs?`)) apiDelete(`/experiments/${experiment.id}`).then(onRefetch) }}
            className="flex items-center gap-1 text-xs text-zinc-600 hover:text-red-400 hover:bg-red-900/30 px-2 py-1 rounded transition-colors">
            <Trash2 size={12} />
          </button>
        </div>
        {/* Action bar */}
        <div className="flex items-center gap-2 flex-wrap mt-2 ml-6" onClick={e => e.stopPropagation()}>
          <button onClick={() => handleExecute(1)} disabled={executing}
            className="flex items-center gap-1 text-xs bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded transition-colors disabled:opacity-50">
            {executing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Run
          </button>
          <button onClick={() => handleExecute(3)} disabled={executing}
            className="flex items-center gap-1 text-xs bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded transition-colors disabled:opacity-50">
            {executing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} x3
          </button>
          {executing && (
            <button onClick={handleAbort} disabled={aborting} className="flex items-center gap-1 text-xs bg-red-900/50 hover:bg-red-800/50 text-red-300 px-2.5 py-1 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {aborting ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />} {aborting ? 'Aborting...' : 'Abort'}
            </button>
          )}
          {hasPartialRuns && (
            <button onClick={handleResume} className="flex items-center gap-1 text-xs bg-blue-900/50 hover:bg-blue-800/50 text-blue-300 px-2 py-1 rounded transition-colors">
              <Play size={12} /> Resume ({progress?.partial || experiment.partial_runs})
            </button>
          )}
          {hasFailedRuns && (
            <button onClick={handleRetry} className="flex items-center gap-1 text-xs bg-amber-900/50 hover:bg-amber-800/50 text-amber-300 px-2 py-1 rounded transition-colors">
              <RotateCcw size={12} /> Retry Failed ({progress.failed})
            </button>
          )}
          {experiment.completed_runs >= 2 && (
            <Link to={`/admin/experiments/${experiment.id}/stability`}
              className="flex items-center gap-1 text-xs bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded transition-colors">
              <BarChart3 size={12} /> Stability
            </Link>
          )}
          {experiment.completed_runs >= 1 && (
            <button
              onClick={async () => { setAnalyzing(true); try { const r = await apiPost(`/experiments/${experiment.id}/analyze`); setAnalysisResult(r.analysis) } catch {} finally { setAnalyzing(false) } }}
              disabled={analyzing}
              className="flex items-center gap-1 text-xs bg-zinc-800 hover:bg-zinc-700 px-2 py-1 rounded transition-colors disabled:opacity-50">
              <Brain size={12} /> {analyzing ? '...' : 'Analyze'}
            </button>
          )}
        </div>
      </div>

      {execError && <div className="mx-4 mb-3 px-3 py-2 rounded text-xs bg-red-900/30 text-red-300">Error: {execError}</div>}

      {/* Progress bar */}
      {progress && (executing || progress.completed + progress.failed > 0) && (
        <div className="mx-4 mb-3">
          <div className="flex items-center gap-3 text-xs mb-1.5">
            {executing && <Loader2 size={12} className="animate-spin text-blue-400" />}
            <span className="text-zinc-400">
              {progress.completed + progress.failed}/{progress.total} done
              {progress.running > 0 && <span className="text-blue-400 ml-2">{progress.running} running</span>}
              {progress.failed > 0 && <span className="text-red-400 ml-2">{progress.failed} failed</span>}
            </span>
            {progress.avgScore !== null && (
              <span className={`font-medium ml-auto ${scoreColor(progress.avgScore)}`}>Avg: {Math.round(progress.avgScore * 100)}%</span>
            )}
          </div>
          <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
            <div className="h-full flex">
              <div className="bg-emerald-500 transition-all duration-500" style={{ width: `${(progress.completed / progress.total) * 100}%` }} />
              <div className="bg-red-500 transition-all duration-500" style={{ width: `${(progress.failed / progress.total) * 100}%` }} />
              {progress.running > 0 && <div className="bg-blue-500 animate-pulse transition-all duration-500" style={{ width: `${(progress.running / progress.total) * 100}%` }} />}
            </div>
          </div>

          {/* Per-run stage dashboard */}
          {progress.runs && progress.runs.length > 0 && (
            <div className="mt-3 space-y-2">
              {progress.runs.map(run => (
                <div key={run.runId} className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-xs text-zinc-300 font-medium truncate max-w-48">{run.videoTitle}</span>
                    <span className="text-[10px] text-zinc-500">#{run.run_number}</span>
                    <StatusBadge status={run.status} />
                    {run.total_score !== null && (
                      <span className={`text-xs font-bold ml-auto ${scoreColor(run.total_score)}`}>{Math.round(run.total_score * 100)}%</span>
                    )}
                  </div>

                  {/* Running: show stage progress with View buttons for completed stages */}
                  {run.status === 'running' && run.totalStages && (
                    <div className="flex gap-1 items-center flex-wrap">
                      {Array.from({ length: run.totalStages }, (_, si) => {
                        const isDone = si < run.currentStage
                        const isCurrent = si === run.currentStage
                        const stageData = run.stages?.find(s => s.stage_index === si)
                        return (
                          <div key={si} className="flex items-center gap-1">
                            {si > 0 && <span className="text-zinc-700 text-[10px]">→</span>}
                            <div className={`rounded text-center shrink-0 ${
                              isCurrent ? 'bg-blue-900/50 border border-blue-700/50'
                              : isDone ? 'bg-emerald-900/40 border border-emerald-800/50'
                              : 'bg-zinc-800 border border-zinc-700/50'
                            }`}>
                              <div className={`px-2 py-1 text-[10px] font-medium ${
                                isCurrent ? 'text-blue-300 animate-pulse'
                                : isDone ? 'text-emerald-400'
                                : 'text-zinc-600'
                              }`}>
                                {isCurrent
                                  ? (run.segmentsTotal
                                      ? `${run.stageName} (${run.segmentsDone || 0}/${run.segmentsTotal})`
                                      : run.stageName)
                                  : isDone ? (stageData?.stage_name || 'Done') : 'Waiting'}
                              </div>
                              {isDone && stageData && (
                                <button
                                  onClick={() => setViewModal({ runId: run.runId, stageIndex: si }, experiment.id)}
                                  className="text-[10px] text-zinc-600 hover:text-white transition-colors pb-1 px-2"
                                >View</button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* Complete: show per-stage similarity with View buttons */}
                  {run.status === 'complete' && run.stages && run.stages.length > 0 && (
                    <div className="flex gap-1 items-center flex-wrap">
                      {run.stages.map((st, si) => (
                        <div key={si} className="flex items-center gap-1">
                          {si > 0 && <span className="text-zinc-700 text-[10px]">→</span>}
                          <div className="bg-zinc-800 rounded px-2 py-1 text-center shrink-0 group relative">
                            <div className="text-[10px] text-zinc-500 truncate max-w-20">{st.stage_name}</div>
                            {st.similarity_percent !== null && (
                              <div className={`text-xs font-bold ${simColor(st.similarity_percent)}`}>{st.similarity_percent}%</div>
                            )}
                            <button
                              onClick={() => setViewModal({ runId: run.runId, stageIndex: st.stage_index }, experiment.id)}
                              className="text-[10px] text-zinc-600 hover:text-white transition-colors mt-0.5"
                            >View</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {run.status === 'partial' && run.stages && run.stages.length > 0 && (
                    <div className="flex gap-1 items-center flex-wrap">
                      {run.stages.map((st, si) => (
                        <div key={si} className="flex items-center gap-1">
                          {si > 0 && <span className="text-zinc-700 text-[10px]">→</span>}
                          <div className="bg-zinc-800 rounded px-2 py-1 text-center shrink-0">
                            <div className="text-[10px] text-zinc-500 truncate max-w-20">{st.stage_name}</div>
                            {st.similarity_percent !== null && (
                              <div className={`text-xs font-bold ${simColor(st.similarity_percent)}`}>{st.similarity_percent}%</div>
                            )}
                            <button
                              onClick={() => setViewModal({ runId: run.runId, stageIndex: st.stage_index }, experiment.id)}
                              className="text-[10px] text-zinc-600 hover:text-white transition-colors mt-0.5"
                            >View</button>
                          </div>
                        </div>
                      ))}
                      <span className="text-[10px] text-blue-400 ml-1">+ pending stages</span>
                    </div>
                  )}
                  {run.status === 'partial' && (!run.stages || run.stages.length === 0) && (
                    <div className="text-[10px] text-blue-400">Partial — needs resume</div>
                  )}
                  {run.status === 'pending' && <div className="text-[10px] text-zinc-600">Waiting...</div>}
                  {run.status === 'failed' && (
                    <div className="text-[10px] text-red-400" title={run.errorMessage || ''}>
                      Failed{run.errorMessage && <span className="text-red-500/70 ml-1">— {run.errorMessage}</span>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {analysisResult && (
        <div className="mx-4 mb-3 bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4">
          <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Cross-Video Analysis</div>
          <pre className="text-sm whitespace-pre-wrap font-mono leading-relaxed text-zinc-300">{analysisResult}</pre>
        </div>
      )}

      {expanded && detail && (
        <div className="border-t border-zinc-800 p-4 space-y-4">
          {/* Video selection */}
          <div>
            <button onClick={() => setShowVideoSelect(!showVideoSelect)} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors">
              {showVideoSelect ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Videos: {savedVideoIds.length > 0
                ? `${selectableVideos.filter(sv => sv.isGroup ? sv.allIds.every(id => savedVideoIds.includes(id)) : savedVideoIds.includes(sv.id)).map(sv => sv.title).join(', ')}`
                : 'All videos (none selected)'}
            </button>
            {showVideoSelect && selectableVideos.length > 0 && (
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {selectableVideos.map(sv => {
                  const checked = sv.isGroup
                    ? sv.allIds.every(id => savedVideoIds.includes(id))
                    : savedVideoIds.includes(sv.id)
                  return (
                    <label key={sv.id}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded border cursor-pointer text-xs transition-colors ${
                        checked ? 'bg-zinc-800 border-zinc-600 text-white' : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
                      }`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleExpVideo(sv.id)} className="sr-only" />
                      <div className={`w-3 h-3 rounded-sm border shrink-0 ${checked ? 'bg-white border-white' : 'border-zinc-600'}`}>
                        {checked && <svg className="w-3 h-3 text-black" viewBox="0 0 12 12"><path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="2" fill="none" /></svg>}
                      </div>
                      <span className="truncate">{sv.title}</span>
                      {sv.isGroup && <span className="text-[10px] ml-auto shrink-0 text-teal-400">Combined</span>}
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          {/* Flow viewer toggle */}
          <div>
            <button onClick={() => setShowFlow(!showFlow)} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors">
              {showFlow ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Flow: {detail.strategy_name} v{detail.version_number} ({stages.length} stages)
            </button>
            {showFlow && stages.length > 0 && (
              <div className="mt-2 space-y-2">
                {stages.map((stage, i) => (
                  <div key={i} className="bg-zinc-800/50 border border-zinc-700/50 rounded p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs bg-zinc-700 px-1.5 py-0.5 rounded text-zinc-300">{i + 1}</span>
                      <StageBadge type={stage.type} />
                      <span className="text-sm font-medium">{stage.name}</span>
                      {stage.model && stage.model !== 'programmatic' && <span className="text-xs text-zinc-500">{stage.model}</span>}
                    </div>
                    {(stage.system_instruction || stage.output_mode) && (<div><div className="text-xs text-zinc-500 mb-1">System Prompt {stage.type !== 'llm_question' && <span className="text-zinc-600">(with auto-appended output mode rules)</span>}</div><pre className="text-xs text-zinc-400 bg-zinc-900 rounded p-2 whitespace-pre-wrap max-h-24 overflow-auto">{stage.type === 'llm_question' ? stage.system_instruction : previewAugmentedSystem(stage.system_instruction, stage.output_mode, stage.type)}</pre></div>)}
                    {stage.prompt && (<div><div className="text-xs text-zinc-500 mb-1">User Prompt</div><pre className="text-xs text-zinc-400 bg-zinc-900 rounded p-2 whitespace-pre-wrap max-h-24 overflow-auto">{stage.prompt}</pre></div>)}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Stage-level metrics averages */}
          {detail.stageMetrics?.length > 0 && (
            <div>
              <h4 className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Stage Progression (avg across runs)</h4>
              <div className="flex gap-2 items-center overflow-x-auto pb-1">
                {detail.stageMetrics.map((sm, i) => (
                  <div key={sm.stage_index} className="flex items-center gap-1">
                    {i > 0 && <span className="text-zinc-600 text-xs px-1">→</span>}
                    <div className="bg-zinc-800 rounded px-3 py-2 text-center min-w-24 shrink-0">
                      <div className="text-xs text-zinc-500 truncate">{sm.stage_name}</div>
                      <div className={`text-sm font-bold ${simColor(sm.avg_similarity)}`}>{sm.avg_similarity}%</div>
                      {sm.avg_delta !== null && (
                        <div className={`text-[10px] ${sm.avg_delta < 0 ? 'text-emerald-400' : sm.avg_delta > 0 ? 'text-red-400' : 'text-zinc-500'}`}>
                          {sm.avg_delta > 0 ? '+' : ''}{sm.avg_delta}pp
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Per-video averages */}
          {detail.videoAverages?.length > 0 && (
            <div>
              <h4 className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Per-Video Scores</h4>
              <div className="grid grid-cols-4 gap-2">
                {detail.videoAverages.map(va => (
                  <div key={va.video_id} className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3 text-center">
                    <div className={`text-lg font-bold ${scoreColor(va.avg_score)}`}>{Math.round(va.avg_score * 100)}%</div>
                    <div className="text-xs text-zinc-500 mt-1 truncate" title={va.video_title}>{va.video_title}</div>
                    <div className="text-xs text-zinc-600">{va.run_count} run{va.run_count !== 1 ? 's' : ''}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      )}

      {/* Stage View Modal — 3-column comparison */}
      {viewModal && <StageViewModal runId={viewModal.runId} stageIndex={viewModal.stageIndex} onClose={() => setViewModal(null)} />}
    </div>
  )
}

/** 3-column modal: Before Stage | After Stage | Human Edit */
function StageViewModal({ runId, stageIndex, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [view, setView] = useState(null) // set after data loads
  const [copied, setCopied] = useState(null)
  const [selectedSegment, setSelectedSegment] = useState(null) // null = list, index = detail

  useEffect(() => {
    authFetch(`/experiments/runs/${runId}/stages/${stageIndex}?_t=${Date.now()}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json()
      })
      .then(d => { setData(d); setView(d.isParallel && d.segments ? 'segments' : 'comparison'); setLoading(false) })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [runId, stageIndex])

  if (loading) return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={onClose}>
      <Loader2 size={24} className="animate-spin text-zinc-400" />
    </div>
  )
  if (error) return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-zinc-900 border border-red-800 rounded-lg p-6 text-sm text-red-300">Failed to load stage: {error}</div>
    </div>
  )
  if (!data) return null

  // Word-level LCS diff within a single line pair
  function wordDiff(beforeText, afterText) {
    const norm = s => s.replace(/[^a-z0-9]/gi, '').toLowerCase()
    const bTok = beforeText.split(/(\s+)/), aTok = afterText.split(/(\s+)/)
    const bN = bTok.map(norm), aN = aTok.map(norm)
    const m = bTok.length, n = aTok.length
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = bN[i-1] === aN[j-1] && bN[i-1] !== ''
          ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1])
    const keptB = new Set(), keptA = new Set()
    let bi = m, bj = n
    while (bi > 0 && bj > 0) {
      if (bN[bi-1] === aN[bj-1] && bN[bi-1] !== '') { keptB.add(bi-1); keptA.add(bj-1); bi--; bj-- }
      else if (dp[bi-1][bj] >= dp[bi][bj-1]) bi--
      else bj--
    }
    return {
      beforeWords: bTok.map((t, i) => ({ text: t, type: keptB.has(i) || !t.trim() ? 'normal' : 'deleted' })),
      afterWords: aTok.map((t, i) => ({ text: t, type: keptA.has(i) || !t.trim() ? 'normal' : 'added' })),
    }
  }

  // LCS-based line diff producing aligned rows for side-by-side view
  function buildAlignedDiff(inputText, outputText) {
    if (!inputText || !outputText) return []
    const norm = s => s.replace(/[^a-z0-9]/gi, '').toLowerCase()
    const inLines = inputText.split('\n'), outLines = outputText.split('\n')
    const m = inLines.length, n = outLines.length
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1))
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        dp[i][j] = norm(inLines[i-1]) === norm(outLines[j-1])
          ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1])
    // Backtrack to edit ops
    const ops = []
    let i = m, j = n
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && norm(inLines[i-1]) === norm(outLines[j-1])) {
        ops.push({ type: 'match', iIdx: i-1, oIdx: j-1 }); i--; j--
      } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
        ops.push({ type: 'add', oIdx: j-1 }); j--
      } else {
        ops.push({ type: 'delete', iIdx: i-1 }); i--
      }
    }
    ops.reverse()
    return ops.map(op => {
      if (op.type === 'match') {
        const b = inLines[op.iIdx], a = outLines[op.oIdx]
        if (b === a) return { before: b, after: a, type: 'same' }
        const { beforeWords, afterWords } = wordDiff(b, a)
        return { before: b, after: a, type: 'modified', beforeWords, afterWords }
      }
      if (op.type === 'delete') return { before: inLines[op.iIdx], after: null, type: 'deleted' }
      return { before: null, after: outLines[op.oIdx], type: 'added' }
    })
  }

  let alignedRows = []
  try {
    alignedRows = buildAlignedDiff(data.input, data.output)
  } catch (e) {
    console.error('[StageViewModal] buildAlignedDiff failed:', e)
  }
  function clientNormalize(text) {
    if (!text) return ''
    const DIGIT_WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine']
    const TEENS = ['ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen']
    const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety']
    function n2w(n) {
      if (n < 10) return DIGIT_WORDS[n]
      if (n < 20) return TEENS[n-10]
      if (n < 100) return TENS[Math.floor(n/10)] + (n%10 ? ' '+DIGIT_WORDS[n%10] : '')
      if (n < 1000) return DIGIT_WORDS[Math.floor(n/100)]+' hundred'+(n%100 ? ' '+n2w(n%100) : '')
      if (n < 1e6) return n2w(Math.floor(n/1000))+' thousand'+(n%1000 ? ' '+n2w(n%1000) : '')
      if (n < 1e9) return n2w(Math.floor(n/1e6))+' million'+(n%1e6 ? ' '+n2w(n%1e6) : '')
      return n2w(Math.floor(n/1e9))+' billion'+(n%1e9 ? ' '+n2w(n%1e9) : '')
    }
    const SYM = {'%':'percent','$':'dollar','&':'and','@':'at','+':'plus'}
    return text
      .replace(/\[\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,2})?)?\]/g, ' ')
      .replace(/\[\d+\.?\d*s\]/g, ' ')
      .replace(/[-—–]/g, ' ')
      .toLowerCase()
      .replace(/[.,!?;:'"()…\u201c\u201d\u2018\u2019\xab\xbb\[\]{}\/\\#*_~`^|<>]/g, '')
      .replace(/\bper\s+cent\b/g, 'percent')
      .replace(/\s+/g, ' ').trim()
      .split(' ')
      .map(w => {
        if (SYM[w]) return SYM[w]
        const m = w.match(/^([%$&@+]?)(\d+)([%$&@+]?)$/)
        if (m) {
          const num = n2w(parseInt(m[2]))
          if (m[1]==='$') return num+' dollars'
          const parts = []
          if (m[1] && SYM[m[1]]) parts.push(SYM[m[1]])
          parts.push(num)
          if (m[3] && SYM[m[3]]) parts.push(SYM[m[3]])
          return parts.join(' ')
        }
        return w
      })
      .join(' ')
  }
  function copyText(text, label) {
    let content
    if (label.endsWith('-norm')) {
      const raw = label === 'before-norm' ? data.input : label === 'after-norm' ? data.output : data.human
      content = text || clientNormalize(raw)
    } else {
      content = text || ''
    }
    navigator.clipboard.writeText(content).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    })
  }
  const similarity = data.metrics?.find(m => m.comparison_type === 'human_vs_current')

  const normAfter = data.outputNormalized || clientNormalize(data.output)
  const normHuman = data.humanNormalized || clientNormalize(data.human)

  const tabs = [
    { id: 'comparison', label: 'Comparison' },
    { id: 'comparison_norm', label: 'Comparison Normalized' },
    { id: 'final_comparison', label: 'Final Comparison' },
    { id: 'input_log', label: 'Input Log' },
    { id: 'output_log', label: 'Output Log' },
    ...(data.segments ? [{ id: 'segments', label: `Segments (${data.segments.length})` }] : []),
  ]

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-[95vw] max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-4">
            <div>
              <span className="font-medium text-sm">{data.stageName}</span>
              <span className="text-xs text-zinc-500 ml-3">{data.model} &middot; {data.runtime_ms ? `${(data.runtime_ms / 1000).toFixed(1)}s` : ''}</span>
              {similarity && (
                <span className={`text-xs font-bold ml-3 ${simColor(similarity.similarity_percent)}`}>
                  {similarity.similarity_percent}% match to human
                </span>
              )}
            </div>
            <div className="flex gap-1 ml-4">
              {tabs.map(t => (
                <button key={t.id} onClick={() => setView(t.id)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    view === t.id ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
                  }`}>{t.label}</button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors"><X size={18} /></button>
        </div>

        {/* Comparison view: aligned Before/After + Human */}
        {view === 'comparison' && (
          <div className="flex-1 grid grid-cols-[2fr_1fr] divide-x divide-zinc-800 overflow-hidden">
            {/* Before + After aligned columns */}
            <div className="flex flex-col overflow-hidden">
              <div className="grid grid-cols-2 divide-x divide-zinc-800 border-b border-zinc-800 shrink-0">
                <div className="px-4 py-2 text-xs text-zinc-400 font-medium flex items-center justify-between">
                  <span>Before Stage (Input) <span className="text-zinc-600 ml-1">Red = deleted</span></span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => copyText(data.inputNormalized, 'before-norm')}
                      className="text-zinc-600 hover:text-zinc-300 transition-colors text-[10px]">
                      {copied === 'before-norm' ? <span className="text-green-400">Copied!</span> : 'Copy Normalized'}
                    </button>
                    <button onClick={() => copyText(data.input, 'before')}
                      className="text-zinc-600 hover:text-zinc-300 transition-colors">
                      {copied === 'before' ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                    </button>
                  </div>
                </div>
                <div className="px-4 py-2 text-xs text-zinc-400 font-medium flex items-center justify-between">
                  <span>After Stage (Output) <span className="text-zinc-600 ml-1">Green = added</span></span>
                  <div className="flex items-center gap-2">
                    <button onClick={() => copyText(data.outputNormalized, 'after-norm')}
                      className="text-zinc-600 hover:text-zinc-300 transition-colors text-[10px]">
                      {copied === 'after-norm' ? <span className="text-green-400">Copied!</span> : 'Copy Normalized'}
                    </button>
                    <button onClick={() => copyText(data.output, 'after')}
                      className="text-zinc-600 hover:text-zinc-300 transition-colors">
                      {copied === 'after' ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                    </button>
                  </div>
                </div>
              </div>
              <div className="overflow-auto flex-1">
                {alignedRows.map((row, i) => (
                  <div key={i} className="grid grid-cols-2 divide-x divide-zinc-800">
                    {/* Before cell */}
                    <div className={`px-4 py-px text-xs font-mono whitespace-pre-wrap leading-relaxed min-h-[1.25rem] ${
                      row.type === 'deleted' ? 'bg-red-950/30' : row.type === 'added' ? 'bg-zinc-900/50' : ''
                    }`}>
                      {row.type === 'added' ? '' :
                       row.type === 'deleted' ? <span className="text-red-400 line-through">{row.before}</span> :
                       row.type === 'modified' ? row.beforeWords.map((w, wi) =>
                         w.type === 'deleted'
                           ? <span key={wi} className="bg-red-900/50 text-red-300 line-through">{w.text}</span>
                           : <span key={wi} className="text-zinc-300">{w.text}</span>
                       ) : <span className="text-zinc-300">{row.before}</span>}
                    </div>
                    {/* After cell */}
                    <div className={`px-4 py-px text-xs font-mono whitespace-pre-wrap leading-relaxed min-h-[1.25rem] ${
                      row.type === 'added' ? 'bg-green-950/30' : row.type === 'deleted' ? 'bg-zinc-900/50' : ''
                    }`}>
                      {row.type === 'deleted' ? '' :
                       row.type === 'added' ? <span className="text-green-400">{row.after}</span> :
                       row.type === 'modified' ? row.afterWords.map((w, wi) =>
                         w.type === 'added'
                           ? <span key={wi} className="bg-green-900/50 text-green-300">{w.text}</span>
                           : <span key={wi} className="text-zinc-300">{w.text}</span>
                       ) : <span className="text-zinc-300">{row.after}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {/* Human column */}
            <div className="flex flex-col overflow-hidden">
              <div className="px-4 py-2 border-b border-zinc-800 text-xs text-zinc-400 font-medium shrink-0 flex items-center justify-between">
                <span>Human Edited</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => copyText(data.humanNormalized, 'human-norm')}
                    className="text-zinc-600 hover:text-zinc-300 transition-colors text-[10px]">
                    {copied === 'human-norm' ? <span className="text-green-400">Copied!</span> : 'Copy Normalized'}
                  </button>
                  <button onClick={() => copyText(data.human, 'human')}
                    className="text-zinc-600 hover:text-zinc-300 transition-colors">
                    {copied === 'human' ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                  </button>
                </div>
              </div>
              <pre className="p-4 text-xs font-mono whitespace-pre-wrap leading-relaxed overflow-auto flex-1 text-zinc-300">{data.human || 'N/A'}</pre>
            </div>
          </div>
        )}

        {/* Comparison Normalized: After vs Human, both normalized */}
        {view === 'comparison_norm' && (
          <div className="flex-1 grid grid-cols-2 divide-x divide-zinc-800 overflow-hidden">
            <div className="flex flex-col overflow-hidden">
              <div className="px-4 py-2 border-b border-zinc-800 text-xs text-zinc-400 font-medium shrink-0 flex items-center justify-between">
                <span>After Stage (Normalized)</span>
                <button onClick={() => { navigator.clipboard.writeText(normAfter); setCopied('norm-after'); setTimeout(() => setCopied(null), 1500) }}
                  className="text-zinc-600 hover:text-zinc-300 transition-colors flex items-center gap-1">
                  {copied === 'norm-after' ? <><Check size={12} className="text-green-400" /><span className="text-green-400 text-[10px]">Copied!</span></> : <><Copy size={12} /><span className="text-[10px]">Copy</span></>}
                </button>
              </div>
              <pre className="p-4 text-xs font-mono whitespace-pre-wrap leading-relaxed overflow-auto flex-1 text-zinc-300">{normAfter || 'N/A'}</pre>
            </div>
            <div className="flex flex-col overflow-hidden">
              <div className="px-4 py-2 border-b border-zinc-800 text-xs text-zinc-400 font-medium shrink-0 flex items-center justify-between">
                <span>Human Edited (Normalized)</span>
                <button onClick={() => { navigator.clipboard.writeText(normHuman); setCopied('norm-human'); setTimeout(() => setCopied(null), 1500) }}
                  className="text-zinc-600 hover:text-zinc-300 transition-colors flex items-center gap-1">
                  {copied === 'norm-human' ? <><Check size={12} className="text-green-400" /><span className="text-green-400 text-[10px]">Copied!</span></> : <><Copy size={12} /><span className="text-[10px]">Copy</span></>}
                </button>
              </div>
              <pre className="p-4 text-xs font-mono whitespace-pre-wrap leading-relaxed overflow-auto flex-1 text-zinc-300">{normHuman || 'N/A'}</pre>
            </div>
          </div>
        )}

        {/* Final Comparison: unified normalized diff — human as reference */}
        {view === 'final_comparison' && (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-4 py-2 border-b border-zinc-800 text-xs text-zinc-400 font-medium shrink-0 flex items-center gap-4">
              <span>Current vs Human (Normalized)</span>
              <span className="text-zinc-600">
                <span className="text-yellow-400">**word**</span> = missed words &nbsp;
                <span className="text-red-400">[word]</span> = extra words
              </span>
              {similarity && (
                <span className={`font-bold ${simColor(similarity.similarity_percent)}`}>
                  {similarity.similarity_percent}% match
                </span>
              )}
            </div>
            <div className="p-4 overflow-auto flex-1">
              <div className="text-sm font-mono whitespace-pre-wrap leading-relaxed">
                {(data.normalizedDiff || []).map((part, i) => {
                  if (part.removed) {
                    // Words in human but missing from output — missed
                    return <span key={i} className="text-yellow-400">**{part.value.trim()}** </span>
                  }
                  if (part.added) {
                    // Words in output but not in human — extra
                    return <span key={i} className="bg-red-950/40 text-red-400">[{part.value.trim()}] </span>
                  }
                  return <span key={i} className="text-zinc-300">{part.value}</span>
                })}
              </div>
            </div>
          </div>
        )}

        {/* Input Log: system instruction + user prompt */}
        {view === 'input_log' && (
          <div className="flex-1 overflow-auto p-5 space-y-4">
            {data.systemInstruction && (
              <div>
                <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                  <Cpu size={12} /> System Instruction
                </div>
                <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-zinc-300 bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4">{data.systemInstruction}</pre>
              </div>
            )}
            <div>
              <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                <MessageSquare size={12} /> User Prompt (with transcript)
              </div>
              <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-zinc-300 bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 max-h-[70vh] overflow-auto">{data.promptUsed || 'N/A'}</pre>
            </div>
          </div>
        )}

        {/* Output Log: raw LLM response + processed output */}
        {view === 'output_log' && (
          <div className="flex-1 overflow-auto p-5 space-y-4">
            {data.llmResponseRaw && (
              <div>
                <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                  <Bot size={12} /> Raw LLM Response
                  <span className="text-zinc-600">{data.llmResponseRaw.length.toLocaleString()} chars</span>
                </div>
                <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-zinc-300 bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 max-h-[50vh] overflow-auto">{data.llmResponseRaw}</pre>
              </div>
            )}
            <div>
              <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                <Bot size={12} /> {data.llmResponseRaw ? 'Processed Output (after applying deletions/keeps)' : 'LLM Response'}
                <span className="text-zinc-600">{data.output?.length?.toLocaleString()} chars</span>
              </div>
              <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-zinc-300 bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 max-h-[80vh] overflow-auto">{data.output || 'N/A'}</pre>
            </div>
          </div>
        )}

        {view === 'segments' && data.segments && selectedSegment === null && (
          <div className="flex-1 overflow-auto p-5">
            <div className="text-xs text-zinc-500 uppercase tracking-wide mb-3 flex items-center gap-2">
              <Layers size={12} /> {data.segments.length} Segments — click to view details
            </div>
            <div className="grid grid-cols-1 gap-2">
              {data.segments.map((seg, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedSegment(i)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-700/50 rounded-lg transition-colors text-left group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xs bg-zinc-700 px-2 py-0.5 rounded text-zinc-300 font-medium shrink-0">#{seg.segment}</span>
                    <span className="text-xs text-zinc-400 truncate">
                      {seg.inputText?.replace(/<[^>]+>/g, '').replace(/\*{5}/g, '').trim().slice(0, 120)}...
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[10px] text-zinc-500">{seg.cleanedText?.length || 0} chars out</span>
                    <ChevronRight size={14} className="text-zinc-600 group-hover:text-zinc-300 transition-colors" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {view === 'segments' && data.segments && selectedSegment !== null && (
          <SegmentDetailView
            segment={data.segments[selectedSegment]}
            segmentIndex={selectedSegment}
            totalSegments={data.segments.length}
            systemInstruction={data.systemInstruction}
            onBack={() => setSelectedSegment(null)}
            onNavigate={setSelectedSegment}
          />
        )}
      </div>
    </div>
  )
}

function SegmentDetailView({ segment, segmentIndex, totalSegments, systemInstruction, onBack, onNavigate }) {
  const [tab, setTab] = useState('side_by_side')
  const [copied, setCopied] = useState(null)
  const seg = segment
  const inputText = seg.inputText || ''
  const outputText = seg.cleanedText || ''

  function copyText(text, label) {
    navigator.clipboard.writeText(text || '').then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const tabs = [
    { id: 'side_by_side', label: 'Input / Output' },
    { id: 'input_log', label: 'Input Log' },
    { id: 'output_log', label: 'Output Log' },
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Navigation bar */}
      <div className="flex items-center justify-between px-5 py-2 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition-colors">
            <ChevronLeft size={14} /> All Segments
          </button>
          <span className="text-zinc-600">|</span>
          <span className="text-sm font-medium text-zinc-200">Segment #{seg.segment}</span>
          <span className="text-xs text-zinc-500">of {totalSegments}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  tab === t.id ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
                }`}>{t.label}</button>
            ))}
          </div>
          <div className="flex items-center gap-1 ml-3">
            <button onClick={() => onNavigate(segmentIndex - 1)} disabled={segmentIndex === 0}
              className="p-1 text-zinc-500 hover:text-white disabled:opacity-30 transition-colors" title="Previous segment">
              <ArrowUp size={14} />
            </button>
            <button onClick={() => onNavigate(segmentIndex + 1)} disabled={segmentIndex >= totalSegments - 1}
              className="p-1 text-zinc-500 hover:text-white disabled:opacity-30 transition-colors" title="Next segment">
              <ArrowDown size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Side-by-side: Input text vs Output text */}
      {tab === 'side_by_side' && (
        <div className="flex-1 grid grid-cols-2 divide-x divide-zinc-800 overflow-hidden">
          <div className="flex flex-col overflow-hidden">
            <div className="px-4 py-2 border-b border-zinc-800 text-xs text-zinc-400 font-medium flex items-center justify-between shrink-0">
              <span>Prompt Sent to LLM</span>
              <button onClick={() => copyText(seg.promptUsed || inputText, 'seg-input')} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                {copied === 'seg-input' ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
              </button>
            </div>
            <pre className="p-4 text-xs font-mono whitespace-pre-wrap leading-relaxed overflow-auto flex-1 text-zinc-300">{seg.promptUsed || inputText || 'N/A'}</pre>
          </div>
          <div className="flex flex-col overflow-hidden">
            <div className="px-4 py-2 border-b border-zinc-800 text-xs text-zinc-400 font-medium flex items-center justify-between shrink-0">
              <span>LLM Output <span className="text-zinc-600 ml-1">{outputText.length.toLocaleString()} chars</span></span>
              <button onClick={() => copyText(outputText, 'seg-output')} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                {copied === 'seg-output' ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
              </button>
            </div>
            <pre className="p-4 text-xs font-mono whitespace-pre-wrap leading-relaxed overflow-auto flex-1 text-zinc-300">{outputText || 'N/A'}</pre>
          </div>
        </div>
      )}

      {/* Input Log: system instruction + full prompt */}
      {tab === 'input_log' && (
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {(seg.systemInstructionUsed || systemInstruction) && (
            <div>
              <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                <Cpu size={12} /> System Instruction Sent
              </div>
              <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-zinc-300 bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4">{seg.systemInstructionUsed || systemInstruction}</pre>
            </div>
          )}
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2 flex items-center gap-2">
              <MessageSquare size={12} /> User Prompt (with transcript)
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-zinc-300 bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 max-h-[70vh] overflow-auto">{seg.promptUsed || 'N/A'}</pre>
          </div>
        </div>
      )}

      {/* Output Log: raw LLM response */}
      {tab === 'output_log' && (
        <div className="flex-1 overflow-auto p-5 space-y-4">
          {seg.llmResponseRaw && (
            <div>
              <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bot size={12} /> Raw LLM Response
                  <span className="text-zinc-600 font-normal normal-case">{seg.llmResponseRaw.length.toLocaleString()} chars</span>
                </div>
                <button onClick={() => copyText(seg.llmResponseRaw, 'seg-raw')} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                  {copied === 'seg-raw' ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                </button>
              </div>
              <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-zinc-300 bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 max-h-[40vh] overflow-auto">{seg.llmResponseRaw}</pre>
            </div>
          )}
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bot size={12} /> {seg.llmResponseRaw ? 'Processed Output (after applying deletions)' : 'LLM Response'}
                <span className="text-zinc-600 font-normal normal-case">{outputText.length.toLocaleString()} chars</span>
              </div>
              <button onClick={() => copyText(outputText, 'seg-out-log')} className="text-zinc-600 hover:text-zinc-300 transition-colors">
                {copied === 'seg-out-log' ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
              </button>
            </div>
            <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed text-zinc-300 bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-4 max-h-[80vh] overflow-auto">{outputText || 'N/A'}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

function CreateExperimentForm({ onCreated }) {
  const { data: strategies, refetch: refetchStrategies } = useApi('/strategies')
  const { data: videos } = useApi('/videos')
  const [mode, setMode] = useState('ai') // ai | existing | manual
  const [selectedStrategy, setSelectedStrategy] = useState(null)
  const [name, setName] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedVersionId, setSelectedVersionId] = useState('')
  const [selectedVideoIds, setSelectedVideoIds] = useState([])
  const [starting, setStarting] = useState(false)
  const [result, setResult] = useState(null)

  // Manual mode state
  const [manualStages, setManualStages] = useState([])
  const [manualFlowName, setManualFlowName] = useState('')
  const [manualCreating, setManualCreating] = useState(false)
  const [manualCreated, setManualCreated] = useState(false)

  // AI proposal state
  const [aiHistory, setAiHistory] = useState([]) // { role: 'user'|'model', content }
  const [aiProposal, setAiProposal] = useState(null) // { name, explanation, stages }
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState(null)
  const [aiInput, setAiInput] = useState('')
  const [aiAccepted, setAiAccepted] = useState(false)
  const [aiModel, setAiModel] = useState('gemini-3.1-pro-preview')
  const chatEndRef = useRef(null)

  async function loadStrategy(strategyId) {
    if (!strategyId) { setSelectedStrategy(null); return }
    const res = await authFetch(`/strategies/${strategyId}`)
    const data = await res.json()
    setSelectedStrategy(data)
    if (data.versions?.length > 0) {
      setSelectedVersionId(String(data.versions[0].id))
    }
  }

  // Collapse grouped videos into single entries for experiment selection.
  // Each group shows as one item; ungrouped videos show individually.
  const selectableVideos = (() => {
    if (!videos) return []
    const grouped = new Map() // group_id -> { group_name, videos: [...] }
    const ungrouped = []
    for (const v of videos) {
      if (v.group_id) {
        if (!grouped.has(v.group_id)) {
          grouped.set(v.group_id, { group_name: v.group_name || `Group ${v.group_id}`, videos: [] })
        }
        grouped.get(v.group_id).videos.push(v)
      } else {
        ungrouped.push(v)
      }
    }
    const items = []
    for (const [groupId, g] of grouped) {
      // Use the first video's id as the representative for this group
      const rep = g.videos[0]
      items.push({
        id: rep.id,
        title: g.group_name,
        isGroup: true,
        groupId,
        videoCount: g.videos.length,
        allIds: g.videos.map(v => v.id),
      })
    }
    for (const v of ungrouped) {
      items.push({ id: v.id, title: v.title, isGroup: false })
    }
    return items
  })()

  function toggleVideo(itemId) {
    const item = selectableVideos.find(sv => sv.id === itemId)
    if (!item) return
    const ids = item.isGroup ? item.allIds : [item.id]
    setSelectedVideoIds(prev => {
      const has = ids.every(id => prev.includes(id))
      return has ? prev.filter(id => !ids.includes(id)) : [...prev, ...ids.filter(id => !prev.includes(id))]
    })
  }

  function selectAllVideos() {
    if (!selectableVideos.length) return
    const allIds = selectableVideos.flatMap(sv => sv.isGroup ? sv.allIds : [sv.id])
    if (selectedVideoIds.length === allIds.length) {
      setSelectedVideoIds([])
    } else {
      setSelectedVideoIds(allIds)
    }
  }

  // AI proposal functions
  async function aiPropose(userMessage) {
    setAiLoading(true)
    setAiError(null)
    const newHistory = [...aiHistory]
    if (userMessage) {
      newHistory.push({ role: 'user', content: userMessage })
    }
    setAiHistory(newHistory)
    setAiInput('')

    try {
      const res = await apiPost('/strategies/ai-propose', {
        message: userMessage || undefined,
        history: newHistory.length > 0 ? newHistory : undefined,
        model: aiModel,
      })

      const modelReply = res.explanation || 'Here is the proposed workflow.'
      newHistory.push({ role: 'model', content: modelReply })
      setAiHistory(newHistory)
      setAiProposal({ name: res.name, explanation: res.explanation, stages: res.stages })
      if (!name) setName(res.name || '')
    } catch (err) {
      setAiError(err.message)
    } finally {
      setAiLoading(false)
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    }
  }

  async function aiRevise(feedback) {
    setAiAccepted(false)
    await aiPropose(feedback)
  }

  function aiReset() {
    setAiHistory([])
    setAiProposal(null)
    setAiAccepted(false)
    setAiError(null)
    setAiInput('')
  }

  // Accept AI proposal: create strategy + version, then set it as selected
  async function handleAcceptProposal() {
    if (!aiProposal) return
    setAiAccepted(true)

    try {
      // Create strategy
      const strategy = await apiPost('/strategies', {
        name: aiProposal.name || `AI Flow ${Date.now()}`,
        description: aiProposal.explanation || null,
      })

      // Create version with stages
      const version = await apiPost(`/strategies/${strategy.id}/versions`, {
        stages: aiProposal.stages,
        notes: 'AI-generated workflow',
      })

      // Set as selected for experiment
      setSelectedStrategy({ ...strategy, versions: [version] })
      setSelectedVersionId(String(version.id))
      refetchStrategies()
    } catch (err) {
      setAiError(`Failed to save flow: ${err.message}`)
      setAiAccepted(false)
    }
  }

  // Manual mode helpers
  function addManualStage(atIndex) {
    const newStage = {
      name: '',
      type: 'llm',
      model: 'gemini-3.1-pro-preview',
      system_instruction: '',
      prompt: '',
      params: { temperature: 1, thinking_level: 'HIGH' },
      description: '',
      output_mode: 'passthrough',
      action: 'segment',
      actionParams: { preset: 'short', minSeconds: 40, maxSeconds: 60, contextSeconds: 30 },
    }
    setManualStages(prev => {
      if (atIndex !== undefined) {
        const arr = [...prev]
        arr.splice(atIndex, 0, newStage)
        return arr
      }
      return [...prev, newStage]
    })
  }

  function updateManualStage(index, updates) {
    setManualStages(prev => prev.map((s, i) => i === index ? { ...s, ...updates } : s))
  }

  function removeManualStage(index) {
    setManualStages(prev => prev.filter((_, i) => i !== index))
  }

  function moveManualStage(index, direction) {
    setManualStages(prev => {
      const arr = [...prev]
      const target = index + direction
      if (target < 0 || target >= arr.length) return arr
      ;[arr[index], arr[target]] = [arr[target], arr[index]]
      return arr
    })
  }

  function buildManualStagesJson() {
    return manualStages.map(s => {
      if (s.type === 'programmatic') {
        return {
          name: s.name || 'Untitled',
          type: 'programmatic',
          action: s.action,
          actionParams: s.action === 'segment' ? {
            minSeconds: Number(s.actionParams.minSeconds) || 40,
            maxSeconds: Number(s.actionParams.maxSeconds) || 80,
            contextSeconds: Number(s.actionParams.contextSeconds) || 30,
          } : {},
        }
      }
      const stage = {
        name: s.name || 'Untitled',
        type: s.type,
        model: s.model,
        system_instruction: s.system_instruction,
        prompt: s.prompt,
        params: { temperature: Number(s.params.temperature) ?? 1 },
        description: s.description || undefined,
      }
      if (s.output_mode && s.output_mode !== 'passthrough') {
        stage.output_mode = s.output_mode
      }
      const modelOpt = MODEL_OPTIONS.find(m => m.id === s.model)
      if (modelOpt && modelOpt.provider !== 'openai') {
        stage.params.thinking_level = s.params.thinking_level || 'OFF'
      }
      return stage
    })
  }

  async function handleCreateManualFlow() {
    if (manualStages.length === 0 || !manualFlowName.trim()) return
    setManualCreating(true)
    try {
      const strategy = await apiPost('/strategies', {
        name: manualFlowName.trim(),
        description: 'Manually created flow',
      })
      const stagesJson = buildManualStagesJson()
      const version = await apiPost(`/strategies/${strategy.id}/versions`, {
        stages: stagesJson,
        notes: 'Manual build',
      })
      setSelectedStrategy({ ...strategy, versions: [version] })
      setSelectedVersionId(String(version.id))
      setManualCreated(true)
      refetchStrategies()
    } catch (err) {
      alert(`Failed to create flow: ${err.message}`)
    } finally {
      setManualCreating(false)
    }
  }

  async function handleStart(e) {
    e.preventDefault()
    if (!selectedVersionId || !name.trim()) return
    setStarting(true)
    try {
      const experiment = await apiPost('/experiments', {
        strategy_version_id: Number(selectedVersionId),
        name: name.trim(),
        notes: notes.trim() || null,
        video_ids: selectedVideoIds.length > 0 ? selectedVideoIds : undefined
      })

      const execResult = await apiPost(`/experiments/${experiment.id}/execute`)
      setResult(execResult)
      onCreated()
    } catch (err) {
      alert(err.message)
    } finally {
      setStarting(false)
    }
  }

  const selectedVersion = selectedStrategy?.versions?.find(v => String(v.id) === selectedVersionId)
  const stages = selectedVersion ? JSON.parse(selectedVersion.stages_json || '[]') : []

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">
      {/* Mode toggle */}
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-zinc-300">New Experiment</div>
        <div className="flex gap-1 text-xs">
          <button type="button" onClick={() => setMode('ai')}
            className={`px-2.5 py-1 rounded flex items-center gap-1 ${mode === 'ai' ? 'bg-violet-900/50 text-violet-300 border border-violet-700/50' : 'text-zinc-500 hover:text-zinc-300'}`}>
            <Sparkles size={11} /> AI Design
          </button>
          <button type="button" onClick={() => setMode('existing')}
            className={`px-2.5 py-1 rounded ${mode === 'existing' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
            Existing Flow
          </button>
          <button type="button" onClick={() => setMode('manual')}
            className={`px-2.5 py-1 rounded flex items-center gap-1 ${mode === 'manual' ? 'bg-amber-900/50 text-amber-300 border border-amber-700/50' : 'text-zinc-500 hover:text-zinc-300'}`}>
            <Cpu size={11} /> Manual
          </button>
        </div>
      </div>

      {/* AI Design Mode */}
      {mode === 'ai' && !aiAccepted && (
        <div className="space-y-3">
          {/* Chat history */}
          {aiHistory.length > 0 && (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {aiHistory.map((msg, i) => (
                <div key={i} className={`text-xs px-3 py-2 rounded ${
                  msg.role === 'user'
                    ? 'bg-zinc-800 text-zinc-300 ml-8'
                    : 'bg-violet-900/20 border border-violet-800/30 text-violet-200 mr-8'
                }`}>
                  {msg.content}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          )}

          {/* Proposed pipeline visualization */}
          {aiProposal && (
            <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-zinc-200">{aiProposal.name}</div>
                <span className="text-xs text-zinc-500">{aiProposal.stages.length} stages</span>
              </div>

              {/* Stage pipeline */}
              <div className="flex flex-wrap gap-1 items-center py-1">
                {aiProposal.stages.map((stage, i) => (
                  <div key={i} className="flex items-center gap-1">
                    {i > 0 && <span className="text-zinc-600 text-xs">→</span>}
                    <span className={`text-xs px-2 py-1 rounded border ${
                      stage.type === 'programmatic' ? 'border-amber-800/50 bg-amber-900/20 text-amber-400' :
                      stage.type === 'llm_parallel' ? 'border-cyan-800/50 bg-cyan-900/20 text-cyan-400' :
                      stage.type === 'llm_question' ? 'border-pink-800/50 bg-pink-900/20 text-pink-400' :
                      'border-violet-800/50 bg-violet-900/20 text-violet-400'
                    }`}>
                      {stage.name}
                    </span>
                  </div>
                ))}
              </div>

              {/* Stage details */}
              <div className="space-y-1.5">
                {aiProposal.stages.map((stage, i) => (
                  <div key={i} className="bg-zinc-900/50 rounded p-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] bg-zinc-700 px-1 py-0.5 rounded text-zinc-400">{i + 1}</span>
                      <StageBadge type={stage.type} />
                      <span className="text-xs font-medium text-zinc-300">{stage.name}</span>
                      {stage.model && <span className="text-[10px] text-zinc-500">{stage.model}</span>}
                    </div>
                    {stage.description && (
                      <div className="text-[11px] text-zinc-500 pl-6">{stage.description}</div>
                    )}
                    {stage.system_instruction && (
                      <div className="pl-6">
                        <div className="text-[10px] text-zinc-600">System:</div>
                        <pre className="text-[10px] text-zinc-500 whitespace-pre-wrap max-h-40 overflow-auto">{stage.system_instruction}</pre>
                      </div>
                    )}
                    {stage.prompt && (
                      <div className="pl-6">
                        <div className="text-[10px] text-zinc-600">Prompt:</div>
                        <pre className="text-[10px] text-zinc-500 whitespace-pre-wrap max-h-40 overflow-auto">{stage.prompt}</pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Accept / revise buttons */}
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={handleAcceptProposal}
                  className="flex items-center gap-1 bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors">
                  <Check size={12} /> Accept & Create Flow
                </button>
                <button type="button" onClick={aiReset}
                  className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 px-2 py-1.5 rounded text-xs transition-colors">
                  <RotateCcw size={12} /> Start Over
                </button>
              </div>
            </div>
          )}

          {/* Input area */}
          {!aiProposal ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-zinc-500">Describe what kind of transcript processing you need, or let AI propose a default pipeline.</div>
                <select value={aiModel} onChange={e => setAiModel(e.target.value)}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-violet-600 ml-2 shrink-0">
                  <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro</option>
                  <option value="gemini-3-flash-preview">Gemini 3 Flash</option>
                  <option value="gpt-5.4">GPT 5.4</option>
                  <option value="claude-opus-4-20250514">Claude Opus 4.6</option>
                  <option value="claude-sonnet-4-20250514">Claude Sonnet 4.6</option>
                </select>
              </div>
              <div className="flex gap-2">
                <input
                  type="text" value={aiInput} onChange={e => setAiInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && aiInput.trim()) { e.preventDefault(); aiPropose(aiInput.trim()) } }}
                  className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-violet-600"
                  placeholder="e.g. Remove fillers, fix grammar, keep timecodes..."
                  disabled={aiLoading}
                />
                <button type="button" onClick={() => aiPropose(aiInput.trim() || null)} disabled={aiLoading}
                  className="flex items-center gap-1 bg-violet-600 hover:bg-violet-500 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50">
                  {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                  {aiInput.trim() ? 'Design' : 'Auto Propose'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="text" value={aiInput} onChange={e => setAiInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && aiInput.trim()) { e.preventDefault(); aiRevise(aiInput.trim()) } }}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-violet-600"
                placeholder="Give feedback to revise... e.g. 'use cheaper models' or 'add a grammar fix stage'"
                disabled={aiLoading}
              />
              <button type="button" onClick={() => { if (aiInput.trim()) aiRevise(aiInput.trim()) }} disabled={aiLoading || !aiInput.trim()}
                className="flex items-center gap-1 bg-zinc-700 hover:bg-zinc-600 text-white px-3 py-1.5 rounded text-xs transition-colors disabled:opacity-50">
                {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                Revise
              </button>
            </div>
          )}

          {aiError && (
            <div className="bg-red-900/20 border border-red-800/50 rounded p-2 text-xs text-red-300">{aiError}</div>
          )}
        </div>
      )}

      {/* Existing Flow Mode */}
      {mode === 'existing' && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Flow</label>
            <select
              onChange={e => loadStrategy(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm focus:outline-none"
            >
              <option value="">Select flow...</option>
              {strategies?.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Version</label>
            <select
              value={selectedVersionId}
              onChange={e => setSelectedVersionId(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm focus:outline-none"
              disabled={!selectedStrategy}
            >
              <option value="">Select version...</option>
              {selectedStrategy?.versions?.map(v => (
                <option key={v.id} value={v.id}>v{v.version_number} {v.notes ? `— ${v.notes}` : ''}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Manual Mode */}
      {mode === 'manual' && !manualCreated && (
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Flow Name</label>
            <input
              type="text" value={manualFlowName} onChange={e => setManualFlowName(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-500"
              placeholder="e.g. My custom pipeline"
            />
          </div>

          {manualStages.length > 0 && (
            <div>
              {manualStages.map((stage, idx) => {
                const modelOpt = MODEL_OPTIONS.find(m => m.id === stage.model)
                const showThinking = stage.type !== 'programmatic'
                return (
                  <div key={idx}>
                    {/* Insert-between button */}
                    {idx > 0 && (
                      <div className="flex items-center gap-2 py-1.5">
                        <div className="flex-1 border-t border-zinc-700/50" />
                        <button type="button" onClick={() => addManualStage(idx)}
                          className="text-[10px] text-zinc-500 hover:text-white hover:bg-zinc-700 border border-dashed border-zinc-600 rounded px-2.5 py-0.5 transition-colors shrink-0">
                          + Insert stage here
                        </button>
                        <div className="flex-1 border-t border-zinc-700/50" />
                      </div>
                    )}
                  <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs bg-zinc-700 px-1.5 py-0.5 rounded text-zinc-300">{idx + 1}</span>
                        <input
                          type="text" value={stage.name} onChange={e => updateManualStage(idx, { name: e.target.value })}
                          className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-zinc-500 w-48"
                          placeholder="Stage name"
                        />
                      </div>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => moveManualStage(idx, -1)} disabled={idx === 0}
                          className="p-1 text-zinc-500 hover:text-white disabled:opacity-30 transition-colors" title="Move up">
                          <ArrowUp size={12} />
                        </button>
                        <button type="button" onClick={() => moveManualStage(idx, 1)} disabled={idx === manualStages.length - 1}
                          className="p-1 text-zinc-500 hover:text-white disabled:opacity-30 transition-colors" title="Move down">
                          <ArrowDown size={12} />
                        </button>
                        <button type="button" onClick={() => removeManualStage(idx)}
                          className="p-1 text-zinc-500 hover:text-red-400 transition-colors" title="Delete stage">
                          <X size={12} />
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="block text-[10px] text-zinc-500 mb-0.5">Type</label>
                        <select value={stage.type} onChange={e => {
                          const newType = e.target.value
                          const updates = { type: newType }
                          if (newType === 'llm_parallel') {
                            updates.system_instruction = updateSegmentRulesInSystem(stage.system_instruction, stage.output_mode)
                          } else if (stage.type === 'llm_parallel') {
                            updates.system_instruction = stripSegmentRules(stage.system_instruction)
                          }
                          updateManualStage(idx, updates)
                        }}
                          className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:outline-none">
                          <option value="llm">LLM (whole transcript)</option>
                          <option value="llm_parallel">LLM Parallel (per segment)</option>
                          <option value="llm_question">LLM Question</option>
                          <option value="programmatic">Programmatic</option>
                        </select>
                      </div>

                      {stage.type === 'programmatic' ? (
                        <>
                          <div>
                            <label className="block text-[10px] text-zinc-500 mb-0.5">Action</label>
                            <select value={stage.action} onChange={e => updateManualStage(idx, { action: e.target.value })}
                              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:outline-none">
                              <option value="segment">Segment</option>
                              <option value="reassemble">Reassemble</option>
                            </select>
                          </div>
                          <div></div>
                          {stage.action === 'segment' && (
                            <div className="col-span-3 grid grid-cols-2 gap-2">
                              <div>
                                <label className="block text-[10px] text-zinc-500 mb-0.5">Segment Size</label>
                                <select
                                  value={stage.actionParams?.preset || 'short'}
                                  onChange={e => {
                                    const p = SEGMENT_PRESETS[e.target.value]
                                    updateManualStage(idx, { actionParams: { ...stage.actionParams, preset: e.target.value, minSeconds: p.minSeconds, maxSeconds: p.maxSeconds } })
                                  }}
                                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:outline-none"
                                >
                                  {Object.entries(SEGMENT_PRESETS).map(([k, v]) => (
                                    <option key={k} value={k}>{v.label}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="block text-[10px] text-zinc-500 mb-0.5">Context Sec</label>
                                <input type="number" value={stage.actionParams?.contextSeconds ?? 30}
                                  onChange={e => updateManualStage(idx, { actionParams: { ...stage.actionParams, contextSeconds: Number(e.target.value) } })}
                                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:outline-none" />
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div>
                            <label className="block text-[10px] text-zinc-500 mb-0.5">Model</label>
                            <select value={stage.model} onChange={e => updateManualStage(idx, { model: e.target.value })}
                              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:outline-none">
                              {MODEL_OPTIONS.map(m => (
                                <option key={m.id} value={m.id}>{m.label}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="block text-[10px] text-zinc-500 mb-0.5">Temperature ({stage.params.temperature})</label>
                            <input type="range" min="0" max="2" step="0.1" value={stage.params.temperature}
                              onChange={e => updateManualStage(idx, { params: { ...stage.params, temperature: parseFloat(e.target.value) } })}
                              className="w-full accent-zinc-400 mt-1" />
                          </div>
                          {showThinking && (
                            <div className="col-span-3 sm:col-span-1">
                              <label className="block text-[10px] text-zinc-500 mb-0.5">Thinking Level</label>
                              <select value={stage.params.thinking_level || 'OFF'}
                                onChange={e => updateManualStage(idx, { params: { ...stage.params, thinking_level: e.target.value } })}
                                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:outline-none">
                                {THINKING_LEVELS.map(lvl => (
                                  <option key={lvl} value={lvl}>{lvl}</option>
                                ))}
                              </select>
                            </div>
                          )}
                          {stage.type !== 'llm_question' && (
                            <div className="col-span-3 sm:col-span-1">
                              <label className="block text-[10px] text-zinc-500 mb-0.5">Output Mode</label>
                              <select value={stage.output_mode || ''}
                                onChange={e => {
                                  const newMode = e.target.value || undefined
                                  const updates = { output_mode: newMode }
                                  if (stage.type === 'llm_parallel') {
                                    updates.system_instruction = updateSegmentRulesInSystem(stage.system_instruction, newMode)
                                  }
                                  updateManualStage(idx, updates)
                                }}
                                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs focus:outline-none">
                                <option value="">None (return cleaned text)</option>
                                <option value="deletion">Deletion (LLM identifies text to remove)</option>
                                <option value="keep_only">Keep Only (LLM identifies text to keep)</option>
                              </select>
                            </div>
                          )}
                          {stage.type === 'llm_parallel' && (
                            <div className="col-span-3 text-[10px] text-cyan-400/70 bg-cyan-900/10 border border-cyan-800/20 rounded px-2 py-1.5">
                              Segment boundary rules are included in the system instruction below. Edit them to customize how the LLM handles {'<context>'}/{'<segment>'} markers.
                            </div>
                          )}
                          <div className="col-span-3">
                            <label className="block text-[10px] text-zinc-500 mb-0.5">System Instruction</label>
                            <textarea value={stage.system_instruction}
                              onChange={e => updateManualStage(idx, { system_instruction: e.target.value })}
                              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-zinc-500 min-h-[48px] resize-y"
                              placeholder="System instruction for the LLM..." rows={2} />
                          </div>
                          <div className="col-span-3">
                            <label className="block text-[10px] text-zinc-500 mb-0.5">User Prompt</label>
                            <textarea value={stage.prompt}
                              onChange={e => updateManualStage(idx, { prompt: e.target.value })}
                              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-zinc-500 min-h-[48px] resize-y"
                              placeholder="User prompt... Use {{transcript}}, {{segment_number}}, {{total_segments}} as placeholders" rows={2} />
                            <div className="text-[10px] text-zinc-600 mt-0.5">
                              Available: {'{{transcript}}'}, {'{{segment_number}}'}, {'{{total_segments}}'}, {'{{llm_answer}}'}
                            </div>
                            {stage.type === 'llm_question' && (
                              <div className="text-[10px] text-pink-400/70 bg-pink-900/10 border border-pink-800/20 rounded px-2 py-1.5 mt-1">
                                Question stage: LLM answer stored as <code className="font-mono bg-pink-900/30 px-1 rounded">{'{{llm_answer}}'}</code>. Transcript passes through unchanged.
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  </div>
                )
              })}
            </div>
          )}

          <button type="button" onClick={() => addManualStage()}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white border border-dashed border-zinc-700 hover:border-zinc-500 rounded px-3 py-2 w-full justify-center transition-colors">
            <Plus size={12} /> Add Stage
          </button>

          {manualStages.length > 0 && (
            <button type="button" onClick={handleCreateManualFlow} disabled={manualCreating || !manualFlowName.trim()}
              className="flex items-center gap-2 bg-white text-black px-4 py-1.5 rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors">
              {manualCreating && <Loader2 size={14} className="animate-spin" />}
              {manualCreating ? 'Creating...' : 'Create Flow & Continue'}
            </button>
          )}
        </div>
      )}

      {/* Show accepted AI flow or selected existing flow info */}
      {(aiAccepted || mode === 'existing' || manualCreated) && stages.length > 0 && (
        <div>
          {(aiAccepted || manualCreated) && (
            <div className="bg-emerald-900/20 border border-emerald-800/50 rounded p-2 text-xs text-emerald-300 mb-2">
              Flow &ldquo;{selectedStrategy?.name}&rdquo; created with {stages.length} stages
            </div>
          )}
          <div className="flex gap-1 items-center overflow-x-auto py-1">
            {stages.map((stage, i) => (
              <div key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-zinc-600 text-xs">→</span>}
                <span className={`text-xs px-2 py-1 rounded border shrink-0 ${
                  stage.type === 'programmatic' ? 'border-amber-800/50 bg-amber-900/20 text-amber-400' :
                  stage.type === 'llm_parallel' ? 'border-cyan-800/50 bg-cyan-900/20 text-cyan-400' :
                  'border-violet-800/50 bg-violet-900/20 text-violet-400'
                }`}>
                  {stage.name}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Common fields: experiment name, videos, notes */}
      {(aiAccepted || mode === 'existing' || manualCreated) && (
        <form onSubmit={handleStart} className="space-y-3">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Experiment Name</label>
            <input
              type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-500"
              placeholder="e.g. Test filler removal v2"
            />
          </div>

          {selectableVideos.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-zinc-400">Videos to analyze</label>
                <button type="button" onClick={selectAllVideos} className="text-xs text-zinc-500 hover:text-zinc-300">
                  {selectedVideoIds.length === selectableVideos.flatMap(sv => sv.isGroup ? sv.allIds : [sv.id]).length ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {selectableVideos.map(sv => {
                  const checked = sv.isGroup ? sv.allIds.every(id => selectedVideoIds.includes(id)) : selectedVideoIds.includes(sv.id)
                  return (
                    <label key={sv.id}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded border cursor-pointer text-sm transition-colors ${
                        checked
                          ? 'bg-zinc-800 border-zinc-600 text-white'
                          : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
                      }`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleVideo(sv.id)} className="sr-only" />
                      <div className={`w-3 h-3 rounded-sm border ${checked ? 'bg-white border-white' : 'border-zinc-600'}`}>
                        {checked && (
                          <svg className="w-3 h-3 text-black" viewBox="0 0 12 12"><path d="M3 6l2 2 4-4" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
                        )}
                      </div>
                      <span className="truncate">{sv.title}</span>
                      {sv.isGroup && (
                        <span className="text-xs ml-auto shrink-0 text-teal-400">Combined</span>
                      )}
                    </label>
                  )
                })}
              </div>
              {selectedVideoIds.length === 0 && (
                <p className="text-xs text-zinc-600 mt-1">No videos selected = run on all videos</p>
              )}
            </div>
          )}

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Notes (optional)</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-500"
              placeholder="What we're testing..." />
          </div>

          {result && (
            <div className={`px-3 py-2 rounded text-xs ${result.error ? 'bg-red-900/30 text-red-300' : 'bg-emerald-900/30 text-emerald-300'}`}>
              {result.error
                ? `Error: ${result.error}`
                : `Done! ${result.completed}/${result.total} runs. Avg score: ${result.avgScore ? Math.round(result.avgScore * 100) + '%' : 'N/A'}`}
            </div>
          )}

          <button type="submit" disabled={starting || !name.trim() || !selectedVersionId}
            className="bg-white text-black px-4 py-1.5 rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors flex items-center gap-2">
            {starting && <Loader2 size={14} className="animate-spin" />}
            {starting ? 'Running...' : 'Start Experiment'}
          </button>
        </form>
      )}
    </div>
  )
}

function StageBadge({ type }) {
  if (type === 'programmatic') {
    return <span className="text-xs px-1.5 py-0.5 rounded border border-amber-800 bg-amber-900/30 text-amber-300 flex items-center gap-1"><Cpu size={10} /></span>
  }
  if (type === 'llm_parallel') {
    return <span className="text-xs px-1.5 py-0.5 rounded border border-cyan-800 bg-cyan-900/30 text-cyan-300 flex items-center gap-1"><Layers size={10} /></span>
  }
  if (type === 'llm_question') {
    return <span className="text-xs px-1.5 py-0.5 rounded border border-pink-800 bg-pink-900/30 text-pink-300 flex items-center gap-1"><MessageCircleQuestion size={10} /></span>
  }
  return <span className="text-xs px-1.5 py-0.5 rounded border border-violet-800 bg-violet-900/30 text-violet-300 flex items-center gap-1"><Bot size={10} /></span>
}

function StatusBadge({ status }) {
  const styles = {
    pending: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    running: 'bg-blue-900/50 text-blue-400 border-blue-800',
    complete: 'bg-emerald-900/50 text-emerald-400 border-emerald-800',
    failed: 'bg-red-900/50 text-red-400 border-red-800',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 text-xs rounded border ${styles[status] || styles.pending}`}>
      {status}
    </span>
  )
}

function scoreColor(score) {
  const pct = score * 100
  if (pct >= 80) return 'text-emerald-400'
  if (pct >= 60) return 'text-amber-400'
  return 'text-red-400'
}

function simColor(pct) {
  if (pct >= 80) return 'text-emerald-400'
  if (pct >= 60) return 'text-amber-400'
  return 'text-red-400'
}
