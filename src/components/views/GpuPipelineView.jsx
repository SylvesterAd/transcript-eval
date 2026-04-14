import { useState, useEffect, useRef } from 'react'
import { useApi } from '../../hooks/useApi.js'
import {
  ChevronDown, ChevronRight, Search, Image, Sparkles, CheckCircle,
  AlertCircle, Clock, Play, Loader2, ExternalLink
} from 'lucide-react'

// --- Helpers ---

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function formatDuration(seconds) {
  if (!seconds) return '-'
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`
  return `${seconds.toFixed(1)}s`
}

function SourceBadge({ source }) {
  const cls = source === 'pexels'
    ? 'bg-emerald-900/40 text-emerald-400 border-emerald-800/50'
    : 'bg-sky-900/40 text-sky-400 border-sky-800/50'
  return <span className={`px-1.5 py-0.5 rounded text-[10px] border ${cls}`}>{source}</span>
}

function StatusBadge({ error }) {
  if (error) return <span className="inline-flex items-center gap-1 text-xs text-red-400"><AlertCircle size={12} /> Failed</span>
  return <span className="inline-flex items-center gap-1 text-xs text-emerald-400"><CheckCircle size={12} /> OK</span>
}

// --- Pipeline stage indicator ---

const STAGES = ['machine', 'search', 'siglip', 'rerank']
const STAGE_LABELS = { machine: 'GPU', search: 'Search', siglip: 'SigLIP', rerank: 'Rerank' }
const STAGE_ICONS = { machine: Sparkles, search: Search, siglip: Image, rerank: Play }

function PipelineStages({ currentStage, currentStatus }) {
  const currentIdx = STAGES.indexOf(currentStage)

  return (
    <div className="flex items-center gap-1">
      {STAGES.map((stage, i) => {
        const Icon = STAGE_ICONS[stage]
        const isActive = i === currentIdx
        const isDone = i < currentIdx
        const cls = isDone
          ? 'bg-emerald-900/40 text-emerald-400 border-emerald-800'
          : isActive
          ? 'bg-blue-900/40 text-blue-400 border-blue-800 animate-pulse'
          : 'bg-zinc-800/40 text-zinc-500 border-zinc-700'

        return (
          <div key={stage} className="flex items-center gap-1">
            {i > 0 && <div className={`w-4 h-px ${isDone ? 'bg-emerald-700' : isActive ? 'bg-blue-700' : 'bg-zinc-700'}`} />}
            <div className={`flex items-center gap-1 px-2 py-1 rounded border text-[10px] ${cls}`}>
              {isActive ? <Loader2 size={10} className="animate-spin" /> : isDone ? <CheckCircle size={10} /> : <Icon size={10} />}
              {STAGE_LABELS[stage]}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// --- Thumbnail grid with video preview ---

function VideoThumbnail({ item, showScore, scoreLabel }) {
  const [playing, setPlaying] = useState(false)

  return (
    <div className="group relative rounded overflow-hidden border border-zinc-800 bg-zinc-900">
      <div className="aspect-video relative cursor-pointer" onClick={() => item.preview_url && setPlaying(!playing)}>
        {playing && item.preview_url ? (
          <video
            src={item.preview_url}
            autoPlay
            loop
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        ) : (
          <>
            {item.thumbnail_url ? (
              <img src={item.thumbnail_url} alt={item.title} className="w-full h-full object-cover" loading="lazy" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-zinc-600"><Image size={20} /></div>
            )}
            {item.preview_url && (
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/30">
                <Play size={24} className="text-white" />
              </div>
            )}
          </>
        )}
      </div>
      <div className="p-1.5 space-y-0.5">
        <div className="flex items-center gap-1">
          <SourceBadge source={item.source} />
          {item.duration > 0 && <span className="text-[10px] text-zinc-500">{item.duration}s</span>}
        </div>
        <div className="text-[10px] text-zinc-400 truncate" title={item.title}>{item.title || 'Untitled'}</div>
        {showScore && item[scoreLabel] != null && (
          <div className="text-[10px] font-mono text-amber-400">{scoreLabel}: {typeof item[scoreLabel] === 'number' ? item[scoreLabel].toFixed(4) : item[scoreLabel]}</div>
        )}
      </div>
    </div>
  )
}

function ThumbnailGrid({ items, title, showScore, scoreLabel, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!items || items.length === 0) return null

  // Group by source
  const bySrc = {}
  for (const item of items) {
    const src = item.source || 'unknown'
    if (!bySrc[src]) bySrc[src] = []
    bySrc[src].push(item)
  }

  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 text-sm font-medium text-zinc-300 hover:text-zinc-100 mb-2">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
        <span className="text-zinc-500 text-xs font-normal">({items.length})</span>
        {Object.keys(bySrc).map(src => (
          <SourceBadge key={src} source={src} />
        ))}
      </button>
      {open && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
          {items.map((item, i) => (
            <VideoThumbnail key={`${item.id}-${i}`} item={item} showScore={showScore} scoreLabel={scoreLabel} />
          ))}
        </div>
      )}
    </div>
  )
}

// --- Run detail (expandable) ---

function RunDetail({ run }) {
  const stages = run.pipeline_stages
  const results = run.results || []

  return (
    <div className="mt-3 space-y-4 border-t border-zinc-800 pt-3">
      {/* Brief */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Brief</div>
        <div className="text-xs text-zinc-300">{run.brief}</div>
      </div>

      {/* Keywords */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Keywords</div>
        <div className="flex flex-wrap gap-1">
          {(run.keywords || []).map((kw, i) => (
            <span key={i} className="px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-300">{kw}</span>
          ))}
        </div>
      </div>

      {/* Pipeline funnel */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-400">{run.num_candidates || 0} candidates</span>
        <span className="text-zinc-600">&rarr;</span>
        <span className="text-zinc-400">{run.num_unique_thumbnails || 0} unique</span>
        <span className="text-zinc-600">&rarr;</span>
        <span className="text-zinc-400">{run.num_videos_reranked || 0} reranked</span>
        <span className="text-zinc-600">&rarr;</span>
        <span className="text-emerald-400 font-medium">{run.num_results || 0} results</span>
      </div>

      {/* Stage 1: Search results */}
      {stages?.search && (
        <ThumbnailGrid
          items={stages.search}
          title="Search Results (Raw)"
          showScore={false}
        />
      )}

      {/* Stage 2: SigLIP filtered */}
      {stages?.siglip && (
        <ThumbnailGrid
          items={stages.siglip}
          title="SigLIP Filtered (Top K)"
          showScore={true}
          scoreLabel="siglip_score"
        />
      )}

      {/* Stage 3: Final results after reranker */}
      <ThumbnailGrid
        items={results}
        title="Final Results (After Reranker)"
        showScore={true}
        scoreLabel="score"
        defaultOpen={true}
      />

      {/* Error */}
      {run.error && (
        <div className="p-3 rounded bg-red-950/30 border border-red-900/50">
          <div className="text-[10px] uppercase tracking-wider text-red-400 mb-1">Error</div>
          <div className="text-xs text-red-300 font-mono">{run.error}</div>
        </div>
      )}
    </div>
  )
}

// --- Active progress section ---

function ActiveProgress({ active }) {
  if (!active || active.length === 0) return null

  return (
    <div className="mb-6 space-y-3">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <Loader2 size={14} className="animate-spin text-blue-400" />
        Active Pipelines
      </h2>
      {active.map(p => (
        <div key={p.pipelineId} className="p-3 rounded border border-blue-900/50 bg-blue-950/20">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-zinc-400 font-mono">{p.pipelineId}</span>
            <span className="text-xs text-zinc-500">{p.stageName} ({p.stageIndex + 1}/{p.totalStages})</span>
          </div>
          <PipelineStages currentStage={p.gpuStage} currentStatus={p.gpuStatus} />
          {p.gpuStatus && (
            <div className="mt-1.5 text-[10px] text-blue-400">{p.gpuStatus}</div>
          )}
          {p.subDone != null && p.subTotal && (
            <div className="mt-1 flex items-center gap-2">
              <div className="flex-1 h-1 bg-zinc-800 rounded overflow-hidden">
                <div className="h-full bg-blue-500 transition-all" style={{ width: `${(p.subDone / p.subTotal) * 100}%` }} />
              </div>
              <span className="text-[10px] text-zinc-500">{p.subDone}/{p.subTotal}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// --- Main view ---

export default function GpuPipelineView() {
  const { data, loading, refetch } = useApi('/gpu/runs')
  const [activeData, setActiveData] = useState(null)
  const [expanded, setExpanded] = useState({})
  const pollRef = useRef(null)

  // Poll for active progress
  useEffect(() => {
    const fetchProgress = async () => {
      try {
        const res = await fetch('/api/gpu/progress')
        if (res.ok) setActiveData(await res.json())
      } catch {}
    }
    fetchProgress()
    pollRef.current = setInterval(fetchProgress, 2000)
    return () => clearInterval(pollRef.current)
  }, [])

  // Auto-refresh runs every 10s
  useEffect(() => {
    const interval = setInterval(() => refetch(true), 10000)
    return () => clearInterval(interval)
  }, [refetch])

  const runs = data?.runs || []
  const active = activeData?.active || []

  const toggleExpand = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }))

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">GPU Pipeline Monitor</h1>
        <button
          onClick={() => refetch()}
          className="px-3 py-1.5 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Active pipelines */}
      <ActiveProgress active={active} />

      {/* Run history */}
      {loading && !runs.length && (
        <div className="flex items-center justify-center py-12 text-zinc-500">
          <Loader2 size={20} className="animate-spin mr-2" /> Loading runs...
        </div>
      )}

      {!loading && runs.length === 0 && (
        <div className="text-center py-12 text-zinc-500">No GPU pipeline runs found</div>
      )}

      <div className="space-y-1">
        {runs.map(run => (
          <div key={run.id} className="border border-zinc-800 rounded bg-zinc-900/50">
            <button
              onClick={() => toggleExpand(run.id)}
              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/30 transition-colors"
            >
              {expanded[run.id] ? <ChevronDown size={14} className="text-zinc-500 shrink-0" /> : <ChevronRight size={14} className="text-zinc-500 shrink-0" />}

              <div className="flex-1 min-w-0 flex items-center gap-3">
                {/* Time */}
                <span className="text-[10px] text-zinc-500 w-16 shrink-0 flex items-center gap-1">
                  <Clock size={10} />
                  {timeAgo(run.created_at)}
                </span>

                {/* Status */}
                <div className="w-16 shrink-0">
                  <StatusBadge error={run.error} />
                </div>

                {/* Brief */}
                <span className="text-xs text-zinc-300 truncate flex-1">{run.brief}</span>

                {/* Keywords count */}
                <span className="text-[10px] text-zinc-500 shrink-0">{(run.keywords || []).length} kw</span>

                {/* Sources */}
                <div className="flex gap-1 shrink-0">
                  {(run.sources || []).map(s => <SourceBadge key={s} source={s} />)}
                </div>

                {/* Funnel */}
                <span className="text-[10px] text-zinc-500 shrink-0 font-mono">
                  {run.num_candidates || 0}&rarr;{run.num_unique_thumbnails || 0}&rarr;{run.num_results || 0}
                </span>

                {/* Duration */}
                <span className="text-[10px] text-zinc-500 w-12 shrink-0 text-right">
                  {formatDuration(run.processing_time_seconds)}
                </span>
              </div>
            </button>

            {expanded[run.id] && (
              <div className="px-4 pb-4">
                <RunDetail run={run} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
