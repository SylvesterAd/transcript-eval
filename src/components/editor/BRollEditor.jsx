import { useState, useCallback, useRef, useEffect, useMemo, useContext } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { BRollContext, useBRollEditorState, authFetchBRollData } from './useBRollEditorState.js'
import { EditorContext } from './EditorView.jsx'
import { matchPlacementsToTranscript } from './brollUtils.js'
import BRollPreview from './BRollPreview.jsx'
import BRollDetailPanel from './BRollDetailPanel.jsx'
import Timeline from './Timeline.jsx'
import PlaybackControls from './PlaybackControls.jsx'
import { apiPost } from '../../hooks/useApi.js'
import { Loader2, Square } from 'lucide-react'

export default function BRollEditor({ groupId, videoId, planPipelineId, allPlanPipelineIds, planVariants: planVariantsProp }) {
  const { id, detail } = useParams()
  const navigate = useNavigate()
  const [activeVariantIdx, setActiveVariantIdx] = useState(0)

  // Build variant list from planVariants (with strategy labels) or fallback to pipeline IDs
  const variants = useMemo(() => {
    if (planVariantsProp?.length) {
      return planVariantsProp.map(v => ({
        id: v.pipelineId,
        label: v.label || `Variant ${String.fromCharCode(65 + planVariantsProp.indexOf(v))}`,
      }))
    }
    if (!allPlanPipelineIds?.length) return [{ id: planPipelineId, label: 'B-Roll' }]
    return allPlanPipelineIds.map((pid, i) => ({
      id: pid,
      label: `Variant ${String.fromCharCode(65 + i)}`,
    }))
  }, [allPlanPipelineIds, planPipelineId, planVariantsProp])

  const activePipelineId = variants[activeVariantIdx]?.id || planPipelineId
  const brollState = useBRollEditorState(activePipelineId)
  const hasEverLoaded = useRef(false)
  if (brollState.placements?.length) hasEverLoaded.current = true

  // Load placement data for inactive variants, resolved against transcript words
  const editorCtx = useContext(EditorContext)
  const transcriptWords = useMemo(() => {
    if (!editorCtx?.state?.tracks) return []
    const audioTrack = editorCtx.state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .sort((a, b) => b.duration - a.duration)[0]
    if (!audioTrack) return []
    return audioTrack.transcriptWords.map(w => ({
      word: w.word,
      start: w.start + (audioTrack.offset || 0),
      end: w.end + (audioTrack.offset || 0),
    }))
  }, [editorCtx?.state?.tracks])

  const [rawInactivePlacements, setRawInactivePlacements] = useState({})
  // Load inactive variant placements, and re-fetch while searches are running
  useEffect(() => {
    if (variants.length <= 1) return
    const inactiveIds = variants.filter((_, i) => i !== activeVariantIdx).map(v => v.id)
    const controller = new AbortController()
    function fetchInactive() {
      for (const pid of inactiveIds) {
        authFetchBRollData(pid, controller.signal)
          .then(data => setRawInactivePlacements(prev => ({ ...prev, [pid]: data.placements || [] })))
          .catch(err => { if (err.name !== 'AbortError') {/* swallow */} })
      }
    }
    fetchInactive()
    // Re-fetch every 5s while a search is running
    const isRunning = brollState.searchProgress?.status === 'running'
    if (!isRunning) return () => controller.abort()
    const interval = setInterval(fetchInactive, 5000)
    return () => {
      clearInterval(interval)
      controller.abort()
    }
  }, [variants, activeVariantIdx, brollState.searchProgress?.status])

  // Cache active variant's placements into inactive cache before switching
  const pendingSelectionRef = useRef(null)
  const handleVariantActivate = useCallback((newIdx, selectIndex) => {
    const currentPid = variants[activeVariantIdx]?.id
    // Cache outgoing variant
    if (currentPid && brollState.rawPlacements?.length) {
      setRawInactivePlacements(prev => ({ ...prev, [currentPid]: brollState.rawPlacements }))
    }
    // If we have cached data for the incoming variant, seed it immediately to avoid blank frames
    const newPid = variants[newIdx]?.id
    const cached = newPid ? rawInactivePlacements[newPid] : null
    if (cached?.length) {
      // Seed synchronously. The load effect will see the seededPipelineIdRef match
      // and skip the SET_LOADING clear, avoiding a blank frame.
      brollState.seedFromCache(newPid, cached)
    }
    if (selectIndex != null) pendingSelectionRef.current = selectIndex
    setActiveVariantIdx(newIdx)
  }, [activeVariantIdx, variants, brollState.rawPlacements, brollState.seedFromCache, rawInactivePlacements])

  // Resolve inactive placements using same transcript matching as active variant.
  // Per-pid cache keeps individual array references stable when only one variant's
  // raw data changed, allowing React.memo in BRollTrack to skip unchanged tracks.
  const resolvedCacheRef = useRef(new Map())
  const inactiveVariantPlacements = useMemo(() => {
    const cache = resolvedCacheRef.current
    const out = {}
    const seen = new Set()
    for (const [pid, placements] of Object.entries(rawInactivePlacements)) {
      seen.add(pid)
      const cached = cache.get(pid)
      if (cached && cached.raw === placements && cached.words === transcriptWords) {
        out[pid] = cached.resolved
        continue
      }
      const resolved = matchPlacementsToTranscript(placements, transcriptWords)
      cache.set(pid, { raw: placements, words: transcriptWords, resolved })
      out[pid] = resolved
    }
    // Evict stale entries for pids that no longer exist
    for (const pid of cache.keys()) {
      if (!seen.has(pid)) cache.delete(pid)
    }
    return out
  }, [rawInactivePlacements, transcriptWords])

  // Apply pending selection after variant switch data loads.
  // activeVariantIdx is a dep because loading/length alone can be unchanged across
  // switches between variants with identical placement counts (common for alt plans).
  useEffect(() => {
    if (pendingSelectionRef.current != null && !brollState.loading && brollState.placements?.length) {
      brollState.selectPlacement(pendingSelectionRef.current)
      pendingSelectionRef.current = null
    }
  }, [activeVariantIdx, brollState.loading, brollState.placements?.length])

  // Sync URL detail (placementId) → selection on mount / URL change
  useEffect(() => {
    if (detail != null && brollState.placements?.length) {
      const idx = parseInt(detail)
      if (!isNaN(idx) && idx !== brollState.selectedIndex) {
        brollState.selectPlacement(idx)
      }
    }
  }, [detail, brollState.placements?.length])

  // Sync selection → URL
  useEffect(() => {
    const idx = brollState.selectedIndex
    const currentUrl = idx != null ? `/editor/${id}/brolls/edit/${idx}` : `/editor/${id}/brolls/edit`
    const expectedDetail = idx != null ? String(idx) : undefined
    if (expectedDetail !== detail) {
      navigate(currentUrl, { replace: true })
    }
  }, [brollState.selectedIndex])
  const [bottomH, setBottomH] = useState(310)
  const splitRef = useRef(null)

  // Horizontal splitter (video/transcript vs timeline)
  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = bottomH
    const onMove = (ev) => {
      const dy = startY - ev.clientY
      setBottomH(Math.max(160, Math.min(600, startH + dy)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [bottomH])

  if (brollState.loading && !hasEverLoaded.current) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-dim">
        <Loader2 size={24} className="text-primary-fixed animate-spin" />
      </div>
    )
  }

  if (brollState.error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-dim">
        <div className="text-sm text-error">{brollState.error}</div>
      </div>
    )
  }

  return (
    <BRollContext.Provider value={brollState}>
      <div ref={splitRef} className="flex-1 flex bg-surface-dim overflow-hidden">
        {/* Left: video + timeline stacked */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Video preview */}
          <div className="flex-1 flex flex-col min-h-0">
            <BRollPreview />
          </div>

          {/* Horizontal splitter */}
          <div
            className="h-4 w-full flex items-center justify-center group relative z-40 shrink-0 cursor-ns-resize"
            onMouseDown={onMouseDown}
          >
            <div className="w-full h-px bg-white/5 group-hover:bg-primary-fixed/30 transition-colors" />
            <div className="absolute w-10 h-1 bg-outline-variant/50 rounded-full group-hover:bg-primary-fixed group-hover:shadow-[0_0_10px_rgba(206,252,0,0.5)] transition-all" />
          </div>

          {/* Bottom: playback controls + timeline */}
          <div className="flex flex-col gap-2 pb-4 shrink-0" style={{ height: `${bottomH}px` }}>
            <PlaybackControls />
            <div className="flex-1 min-h-0">
              <Timeline
                variants={variants}
                activeVariantIdx={activeVariantIdx}
                onVariantActivate={handleVariantActivate}
                inactiveVariantPlacements={inactiveVariantPlacements}
              />
            </div>
          </div>
          <SearchStatusBar
            placements={brollState.placements}
            searchProgress={brollState.searchProgress}
            allPlanPipelineIds={allPlanPipelineIds}
            onRefetch={brollState.refetchEditorData}
          />
        </main>

        {/* Right: detail sidebar — full height from top to bottom */}
        {brollState.selectedPlacement && <BRollDetailPanel />}
      </div>
    </BRollContext.Provider>
  )
}

function SearchStatusBar({ placements, searchProgress, allPlanPipelineIds, onRefetch }) {
  const [searching, setSearching] = useState(false)
  const [stopping, setStopping] = useState(false)

  const completed = placements?.filter(p => p.searchStatus === 'complete').length || 0
  const total = placements?.length || 0
  const pending = total - completed
  const isRunning = searchProgress?.status === 'running'

  async function handleStop() {
    setStopping(true)
    try {
      await apiPost('/broll/pipeline/stop-all')
      // Refetch after a short delay to pick up the failed status
      setTimeout(() => onRefetch?.(), 1000)
    } catch (err) {
      console.error('Stop failed:', err)
    }
    setStopping(false)
  }

  async function handleSearchNext10() {
    if (!allPlanPipelineIds?.length) return
    setSearching(true)
    try {
      await apiPost('/broll/pipeline/search-next-batch', {
        plan_pipeline_ids: allPlanPipelineIds,
        batch_size: 10,
      })
      // Refetch after a short delay so polling kicks in (needs searchProgress.status === 'running')
      setTimeout(() => onRefetch?.(), 2000)
    } catch (err) {
      console.error('Search next batch failed:', err)
    }
    setSearching(false)
  }

  if (!total) return null

  if (isRunning) {
    const phase = searchProgress.phase || 'gpu_search'
    const done = searchProgress.subDone || 0
    const subTotal = searchProgress.subTotal || 0
    const pct = subTotal > 0 ? Math.round((done / subTotal) * 100) : 0
    const label = phase === 'keywords'
      ? `Generating keywords... (${searchProgress.keywordsDone || 0}/${searchProgress.keywordsTotal || 0} variants)`
      : searchProgress.stageName || `Searching B-Roll: ${done}/${subTotal}`
    return (
      <div className="px-4 py-1.5 bg-primary-fixed/5 border-t border-primary-fixed/10 flex items-center gap-3">
        <Loader2 size={12} className="text-primary-fixed animate-spin shrink-0" />
        <span className="text-xs text-primary-fixed shrink-0">{label}</span>
        {phase === 'gpu_search' && subTotal > 0 && (
          <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-primary-fixed rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
        )}
        <button
          onClick={handleStop}
          disabled={stopping}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-red-400 hover:bg-red-900/20 transition-colors disabled:opacity-40 shrink-0"
        >
          <Square size={10} fill="currentColor" />
          {stopping ? 'Stopping...' : 'Stop'}
        </button>
      </div>
    )
  }

  if (pending > 0 && !isRunning) {
    return (
      <div className="px-4 py-1.5 bg-zinc-900/50 border-t border-zinc-800/50 flex items-center gap-3">
        <span className="text-xs text-zinc-400 shrink-0">
          B-Roll: {completed}/{total} found · {pending} remaining
        </span>
        <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
          <div className="h-full bg-primary-fixed/60 rounded-full" style={{ width: `${(completed / total) * 100}%` }} />
        </div>
        <button
          onClick={handleSearchNext10}
          disabled={searching}
          className="flex items-center gap-1 px-3 py-1 rounded text-xs font-bold text-[#cefc00] hover:bg-[#cefc00]/10 border border-[#cefc00]/30 transition-colors disabled:opacity-40 shrink-0"
        >
          {searching ? <Loader2 size={10} className="animate-spin" /> : null}
          {searching ? 'Starting...' : 'Search next 10'}
        </button>
      </div>
    )
  }

  if (completed === total && total > 0) {
    return (
      <div className="px-4 py-1.5 bg-zinc-900/30 border-t border-zinc-800/30 flex items-center gap-2">
        <span className="text-xs text-zinc-500">{completed}/{total} B-Roll clips found</span>
      </div>
    )
  }

  return null
}
