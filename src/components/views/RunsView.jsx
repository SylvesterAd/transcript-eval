import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi.js'
import { ChevronDown, ChevronRight, ExternalLink, Eye, Loader2, X, Cpu, Layers, MessageSquare, MessageCircleQuestion, Sparkles, Copy, Check } from 'lucide-react'

function StatusBadge({ status }) {
  const styles = {
    pending: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    running: 'bg-blue-900/50 text-blue-400 border-blue-800',
    complete: 'bg-emerald-900/50 text-emerald-400 border-emerald-800',
    failed: 'bg-red-900/50 text-red-400 border-red-800',
    partial: 'bg-amber-900/50 text-amber-400 border-amber-800',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 text-xs rounded border ${styles[status] || styles.pending}`}>
      {status}
    </span>
  )
}

function StageTypeBadge({ type }) {
  const cfg = {
    llm: { icon: Cpu, color: 'text-blue-400 bg-blue-900/30 border-blue-800/50' },
    llm_parallel: { icon: Layers, color: 'text-purple-400 bg-purple-900/30 border-purple-800/50' },
    programmatic: { icon: Sparkles, color: 'text-emerald-400 bg-emerald-900/30 border-emerald-800/50' },
    llm_question: { icon: MessageCircleQuestion, color: 'text-amber-400 bg-amber-900/30 border-amber-800/50' },
  }
  const c = cfg[type] || cfg.llm
  const Icon = c.icon
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded border ${c.color}`}>
      <Icon size={10} />
      {type}
    </span>
  )
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
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function formatDuration(createdAt, completedAt) {
  if (!createdAt || !completedAt) return null
  const ms = new Date(completedAt).getTime() - new Date(createdAt).getTime()
  if (ms < 0) return null
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remSecs = secs % 60
  if (mins < 60) return `${mins}m ${remSecs}s`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hrs}h ${remMins}m`
}

export default function RunsView() {
  const { data: runs, loading, refetch } = useApi('/experiments/runs')
  const { data: spending } = useApi('/experiments/spending/today')
  const { data: totalSpending } = useApi('/experiments/spending/total')
  const pollRef = useRef(null)

  // Poll when any run is running
  useEffect(() => {
    if (!runs) return
    const hasRunning = runs.some(r => r.status === 'running' || r.status === 'pending')
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(refetch, 2000)
    } else if (!hasRunning && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [runs, refetch])

  if (loading) return <div className="p-6 text-zinc-500 text-sm">Loading...</div>

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Runs</h2>
        <div className="flex items-center gap-4 text-xs">
          {spending && (
            <span className="text-zinc-400">
              Today: <span className="text-zinc-200 font-medium">{formatCost(spending.total_cost)}</span>
              <span className="text-zinc-600 ml-1">({spending.runs} run{spending.runs !== 1 ? 's' : ''})</span>
            </span>
          )}
          {totalSpending && (
            <span className="text-zinc-400">
              All time: <span className="text-zinc-200 font-medium">{formatCost(totalSpending.total_cost)}</span>
              <span className="text-zinc-600 ml-1">({totalSpending.runs} runs &middot; {formatTokens(totalSpending.total_tokens)} tokens)</span>
            </span>
          )}
        </div>
      </div>

      {!runs || runs.length === 0 ? (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-zinc-500 text-sm">No runs yet.</p>
          <p className="text-zinc-600 text-xs mt-1">Runs will appear here when experiments or auto-runs are executed.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {runs.map(run => (
            <RunRow key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  )
}

function RunRow({ run }) {
  const [expanded, setExpanded] = useState(false)
  const [stageModal, setStageModal] = useState(null) // { runId, stageIndex }

  return (
    <>
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        {/* Summary row */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-zinc-800/50 transition-colors"
        >
          {expanded ? <ChevronDown size={14} className="text-zinc-500 shrink-0" /> : <ChevronRight size={14} className="text-zinc-500 shrink-0" />}

          <StatusBadge status={run.status} />

          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium truncate">
              {run.experiment_name?.startsWith('Auto:') ? run.experiment_name : run.strategy_name}
            </span>
            <span className="text-xs text-zinc-500 ml-2">v{run.version_number}</span>
          </div>

          <div className="text-xs text-zinc-400 truncate max-w-[200px]" title={run.video_title}>
            {run.video_title}
          </div>

          {/* Progress bar */}
          <div className="w-24 shrink-0">
            <div className="flex items-center gap-1.5">
              <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${run.status === 'failed' ? 'bg-red-500' : run.status === 'running' ? 'bg-blue-500' : 'bg-emerald-500'}`}
                  style={{ width: `${run.totalStages > 0 ? (run.completed_stages / run.totalStages) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[10px] text-zinc-500 w-8 text-right">{run.completed_stages}/{run.totalStages}</span>
            </div>
            {run.status === 'running' && run.stageName && (
              <div className="text-[10px] text-blue-400 truncate mt-0.5">
                {run.stageName}
                {run.segmentsTotal ? ` (${run.segmentsDone || 0}/${run.segmentsTotal})` : ''}
              </div>
            )}
          </div>

          <span className="text-xs text-zinc-500 w-16 text-right shrink-0">{formatCost(run.total_cost)}</span>
          <span className="text-xs text-zinc-500 w-12 text-right shrink-0">{formatTokens(run.total_tokens)}</span>
          <span className="text-xs text-zinc-500 w-14 text-right shrink-0" title="LLM processing time">{formatRuntime(run.total_runtime_ms)}</span>
          {formatDuration(run.created_at, run.completed_at) ? (
            <span className="text-xs text-zinc-500 w-16 text-right shrink-0" title="Wall-clock duration">{formatDuration(run.created_at, run.completed_at)}</span>
          ) : (
            <span className="text-xs text-zinc-600 w-16 text-right shrink-0">-</span>
          )}
          <span className="text-xs text-zinc-600 w-16 text-right shrink-0">{timeAgo(run.created_at)}</span>

          {run.group_id && (
            <Link
              to={`/editor/${run.group_id}/roughcut`}
              onClick={e => e.stopPropagation()}
              className="text-zinc-500 hover:text-zinc-300 shrink-0"
              title="Open in Editor"
            >
              <ExternalLink size={14} />
            </Link>
          )}
        </button>

        {/* Expanded stage pipeline */}
        {expanded && <ExpandedRun run={run} onViewStage={(stageIndex) => setStageModal({ runId: run.id, stageIndex })} />}
      </div>

      {/* Stage detail modal */}
      {stageModal && (
        <StageDetailModal
          runId={stageModal.runId}
          stageIndex={stageModal.stageIndex}
          onClose={() => setStageModal(null)}
        />
      )}
    </>
  )
}

function ExpandedRun({ run, onViewStage }) {
  const { data: detail, loading } = useApi(`/experiments/runs/${run.id}`)

  if (loading) return <div className="px-4 py-3 border-t border-zinc-800"><Loader2 size={14} className="animate-spin text-zinc-500" /></div>
  if (!detail) return null

  const stages = detail.stages || []

  return (
    <div className="px-4 py-3 border-t border-zinc-800 bg-zinc-950/50">
      {/* Run metadata */}
      <div className="flex items-center gap-4 text-xs text-zinc-500 mb-3">
        <span>Experiment: {detail.experiment_name}</span>
        <span>Run #{detail.run_number}</span>
        {detail.error_message && <span className="text-red-400">Error: {detail.error_message}</span>}
      </div>

      {/* Stage pipeline */}
      {stages.length === 0 ? (
        <div className="text-xs text-zinc-600">No stage outputs yet</div>
      ) : (
        <div className="flex items-start gap-2 overflow-x-auto pb-2">
          {stages.map((stage, i) => {
            const stageMetrics = detail.metrics?.filter(m => m.stage_index === stage.stage_index) || []
            const hvsCurrent = stageMetrics.find(m => m.comparison_type === 'human_vs_current')

            // Parse stage type from prompt_used marker or default
            const isParallel = stage.prompt_used?.startsWith('[Parallel LLM]')
            const stageType = isParallel ? 'llm_parallel' : (stage.stage_name?.toLowerCase().includes('programmatic') ? 'programmatic' : 'llm')

            return (
              <div key={stage.stage_index} className="flex items-start gap-2">
                {i > 0 && <div className="text-zinc-700 mt-4 shrink-0">&rarr;</div>}
                <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 min-w-[180px] max-w-[220px]">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium truncate">{stage.stage_name}</span>
                    <button
                      onClick={() => onViewStage(stage.stage_index)}
                      className="text-zinc-500 hover:text-zinc-300 shrink-0 ml-1"
                      title="View stage details"
                    >
                      <Eye size={12} />
                    </button>
                  </div>

                  <div className="flex items-center gap-1 mb-1.5">
                    <StageTypeBadge type={stageType} />
                    {stage.model && <span className="text-[10px] text-zinc-600 truncate">{stage.model}</span>}
                  </div>

                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    {stage.tokens_in != null && <span>{formatTokens(stage.tokens_in)}↑ {formatTokens(stage.tokens_out)}↓</span>}
                    {stage.cost != null && <span>{formatCost(stage.cost)}</span>}
                    {stage.runtime_ms != null && <span>{formatRuntime(stage.runtime_ms)}</span>}
                  </div>

                  {hvsCurrent && (
                    <div className={`text-[10px] font-medium mt-1 ${
                      hvsCurrent.similarity_percent >= 80 ? 'text-emerald-400' :
                      hvsCurrent.similarity_percent >= 60 ? 'text-amber-400' : 'text-red-400'
                    }`}>
                      {hvsCurrent.similarity_percent}% match
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StageDetailModal({ runId, stageIndex, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [tab, setTab] = useState('io')
  const [copied, setCopied] = useState(null)
  const [selectedSegment, setSelectedSegment] = useState(null)

  useEffect(() => {
    fetch(`/api/experiments/runs/${runId}/stages/${stageIndex}?_t=${Date.now()}`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json()
      })
      .then(d => {
        setData(d)
        setTab(d.isParallel && d.segments ? 'segments' : 'io')
        setLoading(false)
      })
      .catch(err => { setError(err.message); setLoading(false) })
  }, [runId, stageIndex])

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

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

  function copyText(text, label) {
    navigator.clipboard.writeText(text || '').then(() => {
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const tabs = [
    { id: 'io', label: 'Input / Output' },
    { id: 'config', label: 'Config' },
    { id: 'raw', label: 'Raw Response' },
    ...(data.segments ? [{ id: 'segments', label: `Segments (${data.segments.length})` }] : []),
  ]

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-[90vw] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-3">
            <span className="font-medium text-sm">{data.stageName}</span>
            <span className="text-xs text-zinc-500">
              {data.model} &middot; {data.runtime_ms ? `${(data.runtime_ms / 1000).toFixed(1)}s` : ''}
            </span>
            <div className="flex gap-1 ml-3">
              {tabs.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    tab === t.id ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >{t.label}</button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300"><X size={16} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-5">
          {tab === 'io' && <IOTab data={data} copyText={copyText} copied={copied} />}
          {tab === 'config' && <ConfigTab data={data} copyText={copyText} copied={copied} />}
          {tab === 'raw' && <RawTab data={data} copyText={copyText} copied={copied} />}
          {tab === 'segments' && data.segments && (
            <SegmentsTab
              segments={data.segments}
              selectedSegment={selectedSegment}
              onSelect={setSelectedSegment}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function IOTab({ data, copyText, copied }) {
  return (
    <div className="grid grid-cols-2 gap-4 h-full">
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Input</span>
          <button onClick={() => copyText(data.input, 'input')} className="text-zinc-500 hover:text-zinc-300">
            {copied === 'input' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>
        </div>
        <pre className="text-xs text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap font-mono">
          {data.input || '(empty)'}
        </pre>
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Output</span>
          <button onClick={() => copyText(data.output, 'output')} className="text-zinc-500 hover:text-zinc-300">
            {copied === 'output' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>
        </div>
        <pre className="text-xs text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap font-mono">
          {data.output || '(empty)'}
        </pre>
      </div>
    </div>
  )
}

function ConfigTab({ data, copyText, copied }) {
  return (
    <div className="space-y-4 max-h-[65vh] overflow-auto">
      {/* Model & stage info */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs bg-zinc-800 border border-zinc-700 rounded px-2 py-1">Model: {data.model || '-'}</span>
        {data.isParallel && <StageTypeBadge type="llm_parallel" />}
        {data.runtime_ms && <span className="text-xs text-zinc-500">{formatRuntime(data.runtime_ms)}</span>}
      </div>

      {/* System instruction */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">System Instruction</span>
          <button onClick={() => copyText(data.systemInstruction, 'sys')} className="text-zinc-500 hover:text-zinc-300">
            {copied === 'sys' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>
        </div>
        <pre className="text-xs text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-[30vh] whitespace-pre-wrap font-mono">
          {data.systemInstruction || '(none)'}
        </pre>
      </div>

      {/* Prompt used */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Prompt Used</span>
          <button onClick={() => copyText(data.promptUsed, 'prompt')} className="text-zinc-500 hover:text-zinc-300">
            {copied === 'prompt' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
          </button>
        </div>
        <pre className="text-xs text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-[30vh] whitespace-pre-wrap font-mono">
          {data.promptUsed || '(none)'}
        </pre>
      </div>
    </div>
  )
}

function RawTab({ data, copyText, copied }) {
  const rawText = data.llmResponseRaw || '(no raw response available)'
  let formatted = rawText
  try {
    const parsed = JSON.parse(rawText)
    formatted = JSON.stringify(parsed, null, 2)
  } catch {}

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Raw LLM Response</span>
        <button onClick={() => copyText(rawText, 'raw')} className="text-zinc-500 hover:text-zinc-300">
          {copied === 'raw' ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
        </button>
      </div>
      <pre className="text-xs text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-[65vh] whitespace-pre-wrap font-mono">
        {formatted}
      </pre>
    </div>
  )
}

function SegmentsTab({ segments, selectedSegment, onSelect }) {
  if (selectedSegment !== null && segments[selectedSegment]) {
    const seg = segments[selectedSegment]
    return (
      <div>
        <button onClick={() => onSelect(null)} className="text-xs text-zinc-400 hover:text-zinc-200 mb-3">&larr; Back to segments list</button>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider block mb-1">Segment Input</span>
            <pre className="text-xs text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-[55vh] whitespace-pre-wrap font-mono">
              {seg.input || seg.text || '(no input)'}
            </pre>
          </div>
          <div>
            <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider block mb-1">Segment Output</span>
            <pre className="text-xs text-zinc-300 bg-zinc-950 border border-zinc-800 rounded-lg p-3 overflow-auto max-h-[55vh] whitespace-pre-wrap font-mono">
              {seg.cleanedText || seg.output || '(no output)'}
            </pre>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1 max-h-[65vh] overflow-auto">
      {segments.map((seg, i) => (
        <button
          key={i}
          onClick={() => onSelect(i)}
          className="w-full text-left px-3 py-2 bg-zinc-950 border border-zinc-800 rounded hover:border-zinc-700 transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-300">
              Segment {seg.segment || i + 1}
              {seg.timecode && <span className="text-zinc-500 ml-2">{seg.timecode}</span>}
            </span>
            <ChevronRight size={12} className="text-zinc-600" />
          </div>
          {seg.cleanedText && (
            <div className="text-[11px] text-zinc-500 mt-0.5 truncate">{seg.cleanedText.slice(0, 120)}</div>
          )}
        </button>
      ))}
    </div>
  )
}
