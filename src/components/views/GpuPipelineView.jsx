import { useState, useEffect, useRef } from 'react'
import { useApi } from '../../hooks/useApi.js'
import {
  ChevronDown, ChevronRight, Search, Image, Sparkles, CheckCircle,
  AlertCircle, AlertTriangle, Clock, Play, Loader2, ExternalLink, Copy, Check, XCircle
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

function SourceBadge({ source, isDown }) {
  const base = source === 'pexels'
    ? 'bg-emerald-900/40 text-emerald-400 border-emerald-800/50'
    : 'bg-sky-900/40 text-sky-400 border-sky-800/50'
  const cls = isDown ? 'bg-red-900/30 text-red-400 border-red-800/50 line-through opacity-60' : base
  return <span className={`px-1.5 py-0.5 rounded text-[10px] border ${cls}`}>{source}</span>
}

function SourceWarningBanner({ sourceWarnings }) {
  if (!sourceWarnings || Object.keys(sourceWarnings).length === 0) return null

  const down = Object.entries(sourceWarnings).filter(([, v]) => v === 'down').map(([k]) => k)
  const degraded = Object.entries(sourceWarnings).filter(([, v]) => v === 'degraded').map(([k]) => k)

  let message = ''
  if (down.length > 0 && degraded.length > 0) {
    message = `${down.join(', ')} unreachable, ${degraded.join(', ')} partially failed`
  } else if (down.length > 0) {
    const working = down.includes('pexels') ? 'Storyblocks' : 'Pexels'
    message = `${down.join(', ')} was unreachable — results from ${working} only`
  } else {
    message = `Some ${degraded.join(', ')} thumbnails failed to load — results may be incomplete`
  }

  return (
    <div className="p-3 rounded bg-amber-950/30 border border-amber-900/50">
      <div className="flex items-center gap-2">
        <AlertTriangle size={14} className="text-amber-400 shrink-0" />
        <span className="text-xs text-amber-300">{message}</span>
      </div>
    </div>
  )
}

function StatusBadge({ error, jobStatus }) {
  if (error) return <span className="inline-flex items-center gap-1 text-xs text-red-400"><AlertCircle size={12} /> Failed</span>
  if (jobStatus && jobStatus !== 'complete') {
    return <span className="inline-flex items-center gap-1 text-xs text-amber-400"><Clock size={12} /> {jobStatus}</span>
  }
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

const PAGE_SIZE = 50
const MAX_ITEMS = 100

function ThumbnailGrid({ items, title, showScore, scoreLabel, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  const [page, setPage] = useState(0)
  if (!items || items.length === 0) return null

  const capped = items.slice(0, MAX_ITEMS)
  const totalPages = Math.ceil(capped.length / PAGE_SIZE)
  const pageItems = capped.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // Group by source for badges
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
        <span className="text-zinc-500 text-xs font-normal">({items.length}{items.length > MAX_ITEMS ? `, showing ${MAX_ITEMS}` : ''})</span>
        {Object.keys(bySrc).map(src => (
          <SourceBadge key={src} source={src} />
        ))}
      </button>
      {open && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
            {pageItems.map((item, i) => (
              <VideoThumbnail key={`${item.id}-${page}-${i}`} item={item} showScore={showScore} scoreLabel={scoreLabel} />
            ))}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-3">
              <button
                disabled={page === 0}
                onClick={() => setPage(p => p - 1)}
                className="px-2 py-1 text-[10px] rounded border border-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
              >
                Prev
              </button>
              <span className="text-[10px] text-zinc-500">Page {page + 1} of {totalPages}</span>
              <button
                disabled={page >= totalPages - 1}
                onClick={() => setPage(p => p + 1)}
                className="px-2 py-1 text-[10px] rounded border border-zinc-800 text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// --- Copy button ---

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false)
  if (!text) return null
  return (
    <button
      onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(String(text)); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
      className="p-0.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 transition-colors inline-flex"
      title="Copy"
    >
      {copied ? <Check size={10} className="text-green-400" /> : <Copy size={10} />}
    </button>
  )
}

// --- Compact funnel for list row (merges live progress) ---

function CompactFunnel({ run, active }) {
  // Find matching active progress by job_id
  const liveProgress = active.find(p => p.gpuJobId && run.job_id && p.gpuJobId === run.job_id)
  const candidates = run.num_candidates || 0
  const unique = run.num_unique_thumbnails || 0
  const results = run.num_results || 0

  if (!liveProgress) {
    // Static funnel
    return (
      <span className="text-[10px] text-zinc-500 shrink-0 font-mono">
        {candidates}&rarr;{unique}&rarr;{results}
      </span>
    )
  }

  // Live funnel
  const stage = liveProgress.gpuStage
  const done = liveProgress.subDone
  const total = liveProgress.subTotal

  let stageLabel
  if (stage === 'search') {
    stageLabel = <span className="text-blue-400">searching...</span>
  } else if (stage === 'siglip') {
    stageLabel = <span className="text-blue-400">SigLIP {done != null ? `${done}/${total}` : '...'}</span>
  } else if (stage === 'rerank') {
    stageLabel = <span className="text-blue-400">rerank {done != null ? `${done}/${total}` : '...'}</span>
  } else if (stage === 'machine') {
    stageLabel = <span className="text-amber-400">GPU...</span>
  } else {
    stageLabel = <span className="text-blue-400">{stage}...</span>
  }

  return (
    <span className="text-[10px] shrink-0 font-mono flex items-center gap-1">
      <span className="text-zinc-500">{candidates}&rarr;{unique}&rarr;</span>
      <Loader2 size={8} className="animate-spin text-blue-400" />
      {stageLabel}
    </span>
  )
}

// --- Pipeline funnel with live progress ---

function PipelineFunnel({ run, stages }) {
  const stats = stages?.stats || {}
  const candidates = run.num_candidates || stats.candidates || 0
  const unique = run.num_unique_thumbnails || stats.unique || 0
  const siglipProcessed = stats.siglip_processed
  const siglipTotal = stats.siglip_total || unique
  const siglipFiltered = stages?.siglip?.length || 0
  const rerankDone = stats.rerank_done
  const rerankTotal = stats.rerank_total || 0
  const results = run.num_results || 0

  const isScoring = run.job_status === 'scoring' || run.job_status === 'gpu_ready'
  const isScored = run.job_status === 'scored' || run.job_status === 'complete'

  return (
    <div className="flex items-center gap-1.5 text-xs flex-wrap">
      <span className="text-zinc-400">{candidates} candidates</span>
      <span className="text-zinc-600">&rarr;</span>
      <span className="text-zinc-400">{unique} unique</span>
      <span className="text-zinc-600">&rarr;</span>

      {/* SigLIP batch progress */}
      {siglipProcessed != null && !isScored ? (
        <span className="text-blue-400 flex items-center gap-1">
          <Loader2 size={10} className="animate-spin" />
          SigLIP {siglipProcessed}/{siglipTotal}
        </span>
      ) : siglipFiltered > 0 ? (
        <span className="text-emerald-400">{siglipFiltered} SigLIP</span>
      ) : isScoring ? (
        <span className="text-blue-400 flex items-center gap-1">
          <Loader2 size={10} className="animate-spin" />
          SigLIP...
        </span>
      ) : (
        <span className="text-zinc-500">0 SigLIP</span>
      )}

      <span className="text-zinc-600">&rarr;</span>

      {/* Rerank progress */}
      {rerankDone != null && rerankDone < rerankTotal ? (
        <span className="text-blue-400 flex items-center gap-1">
          <Loader2 size={10} className="animate-spin" />
          {rerankDone}/{rerankTotal} reranked
        </span>
      ) : (
        <span className="text-zinc-400">{run.num_videos_reranked || rerankTotal || 0} reranked</span>
      )}

      <span className="text-zinc-600">&rarr;</span>
      <span className={results > 0 ? "text-emerald-400 font-medium" : "text-zinc-500"}>{results} results</span>
    </div>
  )
}

// --- Run detail (expandable) ---

const GPU_PROXY_URL = 'https://gpu-proxy-production.up.railway.app'

function RunDetail({ run, onAbort }) {
  const stages = run.pipeline_stages
  const results = run.results || []
  const jobId = run.job_id || null
  const isInProgress = run.job_status && !['complete', 'failed'].includes(run.job_status)

  return (
    <div className="mt-3 space-y-4 border-t border-zinc-800 pt-3">
      {/* Abort button for in-progress/stuck jobs */}
      {isInProgress && jobId && (
        <button
          onClick={() => onAbort(run.id, jobId)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-red-800/50 text-red-400 hover:text-red-300 hover:border-red-700 hover:bg-red-950/30 transition-colors"
        >
          <XCircle size={12} />
          Abort Job
        </button>
      )}

      {/* IDs & Links */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 w-20 shrink-0">Log ID</span>
          <code className="text-xs text-zinc-300 font-mono">{run.id}</code>
          <CopyBtn text={run.id} />
        </div>
        {jobId && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 w-20 shrink-0">Job ID</span>
            <code className="text-xs text-zinc-300 font-mono">{jobId}</code>
            <CopyBtn text={jobId} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500 w-20 shrink-0">Endpoint</span>
          <code className="text-xs text-blue-400 font-mono">POST {GPU_PROXY_URL}/broll/search</code>
          <CopyBtn text={`POST ${GPU_PROXY_URL}/broll/search`} />
        </div>
        {jobId && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 w-20 shrink-0">Job URL</span>
            <code className="text-xs text-blue-400 font-mono">{GPU_PROXY_URL}/jobs/{jobId}</code>
            <CopyBtn text={`${GPU_PROXY_URL}/jobs/${jobId}`} />
          </div>
        )}
        {run.instance_id && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-zinc-500 w-20 shrink-0">Instance</span>
            <code className="text-xs text-zinc-300 font-mono">{run.instance_id}</code>
            <CopyBtn text={run.instance_id} />
          </div>
        )}
      </div>

      {/* Brief */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Brief</div>
        <div className="text-xs text-zinc-300 whitespace-pre-wrap">{run.brief}</div>
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
      <PipelineFunnel run={run} stages={stages} />

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

      {/* Source warnings */}
      <SourceWarningBanner sourceWarnings={stages?.source_warnings} />

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

// --- GPU Machine Status ---

function GpuMachineStatus({ status, active }) {
  if (!status) return null

  const machineStatus = status.machine_status
  const hasActive = active && active.length > 0

  const statusConfig = {
    running: { color: 'emerald', label: 'Running', icon: CheckCircle, pulse: false },
    starting: { color: 'amber', label: 'Starting', icon: Loader2, pulse: true },
    stopped: { color: 'zinc', label: 'Stopped', icon: Clock, pulse: false },
    none: { color: 'zinc', label: 'No Machine', icon: AlertCircle, pulse: false },
  }

  const cfg = statusConfig[machineStatus] || statusConfig.none
  const Icon = cfg.icon

  return (
    <div className={`mb-6 p-4 rounded-lg border ${
      machineStatus === 'running' ? 'border-emerald-800/50 bg-emerald-950/20' :
      machineStatus === 'starting' ? 'border-amber-800/50 bg-amber-950/20' :
      'border-zinc-800 bg-zinc-900/50'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${
            machineStatus === 'running' ? 'bg-emerald-400' :
            machineStatus === 'starting' ? 'bg-amber-400 animate-pulse' :
            'bg-zinc-600'
          }`} />
          <div className="flex items-center gap-2">
            <Icon size={14} className={`${
              machineStatus === 'running' ? 'text-emerald-400' :
              machineStatus === 'starting' ? 'text-amber-400 animate-spin' :
              'text-zinc-500'
            }`} />
            <span className={`text-sm font-medium ${
              machineStatus === 'running' ? 'text-emerald-300' :
              machineStatus === 'starting' ? 'text-amber-300' :
              'text-zinc-400'
            }`}>{cfg.label}</span>
          </div>
          {status.gpu && <span className="text-xs text-zinc-500">{status.gpu}</span>}
          {status.instance_id && <span className="text-[10px] font-mono text-zinc-600">#{status.instance_id}</span>}
        </div>
        {status.cost_per_hour > 0 && (
          <span className="text-xs text-zinc-500">${status.cost_per_hour.toFixed(4)}/hr</span>
        )}
      </div>

      {/* Active pipelines inline */}
      {hasActive && (
        <div className="mt-3 space-y-2 border-t border-zinc-800/50 pt-3">
          {active.map(p => (
            <div key={p.pipelineId} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <PipelineStages currentStage={p.gpuStage} currentStatus={p.gpuStatus} />
                <span className="text-[10px] text-zinc-500">{p.stageName}</span>
              </div>
              {p.gpuStatus && (
                <div className="text-[10px] text-blue-400">{p.gpuStatus}</div>
              )}
              {p.subDone != null && p.subTotal && (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1 bg-zinc-800 rounded overflow-hidden">
                    <div className="h-full bg-blue-500 transition-all" style={{ width: `${(p.subDone / p.subTotal) * 100}%` }} />
                  </div>
                  <span className="text-[10px] text-zinc-500">{p.subDone}/{p.subTotal}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Main view ---

export default function GpuPipelineView() {
  const { data, loading, refetch } = useApi('/gpu/runs')
  const [activeData, setActiveData] = useState(null)
  const [gpuStatus, setGpuStatus] = useState(null)
  const [expanded, setExpanded] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const runId = params.get('run')
    return runId ? { [runId]: true } : {}
  })
  const pollRef = useRef(null)

  // Poll for active progress + GPU machine status
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const { supabase } = await import('../../lib/supabaseClient.js')
        const headers = {}
        if (supabase) {
          const { data: s } = await supabase.auth.getSession()
          if (s.session?.access_token) headers.Authorization = `Bearer ${s.session.access_token}`
        }
        const base = import.meta.env.VITE_API_URL || '/api'
        const [progressRes, statusRes] = await Promise.all([
          fetch(`${base}/gpu/progress`, { headers }),
          fetch(`${GPU_PROXY_URL}/status`),
        ])
        if (progressRes.ok) setActiveData(await progressRes.json())
        if (statusRes.ok) setGpuStatus(await statusRes.json())
      } catch {}
    }
    fetchStatus()
    pollRef.current = setInterval(fetchStatus, 3000)
    return () => clearInterval(pollRef.current)
  }, [])

  // Auto-refresh runs every 10s
  useEffect(() => {
    const interval = setInterval(() => refetch(true), 10000)
    return () => clearInterval(interval)
  }, [refetch])

  const runs = data?.runs || []
  const active = activeData?.active || []
  const [runDetails, setRunDetails] = useState({})
  const [page, setPage] = useState(0)

  // Auto-fetch details for URL-specified run
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const runId = params.get('run')
    if (runId && runs.length > 0 && !runDetails[runId]) {
      toggleExpand(runId)
    }
  }, [runs.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const RUNS_PER_PAGE = 20
  const totalPages = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE))
  const pagedRuns = runs.slice(page * RUNS_PER_PAGE, (page + 1) * RUNS_PER_PAGE)

  const fetchRunDetail = async (id) => {
    try {
      const { supabase } = await import('../../lib/supabaseClient.js')
      const headers = {}
      if (supabase) {
        const { data: s } = await supabase.auth.getSession()
        if (s.session?.access_token) headers.Authorization = `Bearer ${s.session.access_token}`
      }
      const base = import.meta.env.VITE_API_URL || '/api'
      const res = await fetch(`${base}/gpu/runs/${id}`, { headers })
      if (res.ok) {
        const detail = await res.json()
        setRunDetails(prev => ({ ...prev, [id]: detail }))
      }
    } catch {}
  }

  const toggleExpand = async (id) => {
    const isOpen = expanded[id]
    setExpanded(prev => ({ ...prev, [id]: !isOpen }))
    // Sync URL
    const url = new URL(window.location)
    if (!isOpen) { url.searchParams.set('run', id) } else { url.searchParams.delete('run') }
    window.history.replaceState({}, '', url)
    if (!isOpen && !runDetails[id]) fetchRunDetail(id)
  }

  // Auto-refresh expanded in-progress runs every 3s
  useEffect(() => {
    const expandedIds = Object.keys(expanded).filter(id => expanded[id])
    if (expandedIds.length === 0) return
    const inProgress = expandedIds.filter(id => {
      const run = runs.find(r => r.id === id)
      return run && run.job_status && !['complete', 'failed'].includes(run.job_status)
    })
    if (inProgress.length === 0) return
    const interval = setInterval(() => {
      inProgress.forEach(id => fetchRunDetail(id))
    }, 3000)
    return () => clearInterval(interval)
  }, [expanded, runs]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleAbort = async (runId, jobId) => {
    if (!confirm('Abort this job?')) return
    try {
      const { supabase } = await import('../../lib/supabaseClient.js')
      const headers = { 'Content-Type': 'application/json' }
      if (supabase) {
        const { data: s } = await supabase.auth.getSession()
        if (s.session?.access_token) headers.Authorization = `Bearer ${s.session.access_token}`
      }
      const base = import.meta.env.VITE_API_URL || '/api'
      const res = await fetch(`${base}/gpu/runs/${runId}/abort`, { method: 'POST', headers })
      if (res.ok) {
        setRunDetails(prev => ({ ...prev, [runId]: { ...prev[runId], job_status: 'failed', error: 'Aborted by user' } }))
        refetch()
      }
    } catch {}
  }

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

      {/* GPU Status + Active pipelines */}
      <GpuMachineStatus status={gpuStatus} active={active} />

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
        {pagedRuns.map(run => (
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
                <div className="w-20 shrink-0">
                  <StatusBadge error={run.error} jobStatus={run.job_status} />
                </div>

                {/* Brief */}
                <span className="text-xs text-zinc-300 truncate flex-1">{run.brief}</span>

                {/* Keywords count */}
                <span className="text-[10px] text-zinc-500 shrink-0">{(run.keywords || []).length} kw</span>

                {/* Sources */}
                <div className="flex gap-1 shrink-0">
                  {(run.sources || []).map(s => <SourceBadge key={s} source={s} />)}
                </div>

                {/* Funnel — merge live progress if active */}
                <CompactFunnel run={run} active={active} />

                {/* Duration */}
                <span className="text-[10px] text-zinc-500 w-12 shrink-0 text-right">
                  {formatDuration(run.processing_time_seconds)}
                </span>
              </div>
            </button>

            {expanded[run.id] && (
              <div className="px-4 pb-4">
                {runDetails[run.id] ? (
                  <RunDetail run={{ ...run, ...runDetails[run.id] }} onAbort={handleAbort} />
                ) : (
                  <div className="py-4 flex items-center justify-center text-zinc-500 text-xs">
                    <Loader2 size={14} className="animate-spin mr-2" /> Loading details...
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-4">
          <button
            disabled={page === 0}
            onClick={() => setPage(0)}
            className="px-2 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors"
          >
            First
          </button>
          <button
            disabled={page === 0}
            onClick={() => setPage(p => p - 1)}
            className="px-3 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors"
          >
            Prev
          </button>
          <span className="text-xs text-zinc-500">
            Page {page + 1} of {totalPages} <span className="text-zinc-600">({runs.length} total)</span>
          </span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage(p => p + 1)}
            className="px-3 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors"
          >
            Next
          </button>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage(totalPages - 1)}
            className="px-2 py-1 text-xs rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors"
          >
            Last
          </button>
        </div>
      )}
    </div>
  )
}
