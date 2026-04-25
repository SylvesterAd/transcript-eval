import { useState, useCallback, useRef, useEffect, useMemo, useContext } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { BRollContext, useBRollEditorState, authFetchBRollData, userPlacementToRawEntry } from './useBRollEditorState.js'
import { EditorContext } from './EditorView.jsx'
import { matchPlacementsToTranscript } from './brollUtils.js'
import BRollPreview from './BRollPreview.jsx'
import BRollDetailPanel from './BRollDetailPanel.jsx'
import Timeline from './Timeline.jsx'
import PlaybackControls from './PlaybackControls.jsx'
import { apiPost } from '../../hooks/useApi.js'
import { Loader2, Square } from 'lucide-react'
import { scheduleBrollPreload, clearBrollPreload } from './brollPreloader.js'

export function resolveDetailToIndex(detail) {
  if (detail == null || detail === '') return null
  if (typeof detail === 'string' && detail.startsWith('user:')) return detail
  const n = parseInt(detail, 10)
  return Number.isFinite(n) ? n : null
}

export default function BRollEditor({ groupId, videoId, planPipelineId, allPlanPipelineIds, planVariants: planVariantsProp }) {
  const { id, detail } = useParams()
  const navigate = useNavigate()
  const [activeVariantIdx, setActiveVariantIdx] = useState(0)
  const editorCtx = useContext(EditorContext)

  // Auto-hide the variant picker on the hands-off path. path_id already lives in
  // EditorContext's groupDetail (loaded by EditorView) — read it from there
  // instead of refetching.
  const pathId = editorCtx?.state?.groupDetail?.path_id || null

  // Build variant list from planVariants (with strategy labels) or fallback to pipeline IDs.
  // For the hands-off path we hide the picker by collapsing to the first variant — the
  // user opted out of manual variant selection, so we just auto-use variant 0.
  const variants = useMemo(() => {
    let all
    if (planVariantsProp?.length) {
      all = planVariantsProp.map(v => ({
        id: v.pipelineId,
        label: v.label || `Variant ${String.fromCharCode(65 + planVariantsProp.indexOf(v))}`,
      }))
    } else if (!allPlanPipelineIds?.length) {
      all = [{ id: planPipelineId, label: 'B-Roll' }]
    } else {
      all = allPlanPipelineIds.map((pid, i) => ({
        id: pid,
        label: `Variant ${String.fromCharCode(65 + i)}`,
      }))
    }
    return pathId === 'hands-off' ? all.slice(0, 1) : all
  }, [allPlanPipelineIds, planPipelineId, planVariantsProp, pathId])

  const activePipelineId = variants[activeVariantIdx]?.id || planPipelineId
  const brollState = useBRollEditorState(activePipelineId)
  const hasEverLoaded = useRef(false)
  if (brollState.placements?.length) hasEverLoaded.current = true

  // Load placement data for inactive variants, resolved against transcript words
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
  const pendingSelectionTsRef = useRef(0)
  const handleVariantActivate = useCallback((newIdx, selectIdentity) => {
    const currentPid = variants[activeVariantIdx]?.id
    // Cache outgoing variant — apply local edits and hide flags so the inactive display
    // matches what the user just saw (avoids a visual jump from old → new position when
    // the parallel fetchInactive refetches editor-data). Strip out the server's merged
    // userPlacements (isUserPlacement: true) and re-inject from local state.userPlacements
    // so unsaved local pastes/drag-cross results are reflected on the now-inactive track.
    if (currentPid && brollState.rawPlacements?.length) {
      const edits = brollState.edits || {}
      const localUps = brollState.userPlacements || []
      const originals = brollState.rawPlacements
        .filter(p => {
          if (p.isUserPlacement) return false
          if (p.chapterIndex == null || p.placementIndex == null) return true
          return !edits[`${p.chapterIndex}:${p.placementIndex}`]?.hidden
        })
        .map(p => {
          if (p.chapterIndex == null || p.placementIndex == null) return p
          const e = edits[`${p.chapterIndex}:${p.placementIndex}`]
          if (!e) return p
          let next = p
          if (e.timelineStart != null && e.timelineEnd != null) {
            next = { ...next, userTimelineStart: e.timelineStart, userTimelineEnd: e.timelineEnd }
          }
          if (e.selectedResult != null) {
            next = { ...next, persistedSelectedResult: e.selectedResult }
          }
          return next
        })
      const snapshot = [
        ...originals,
        ...localUps.map(userPlacementToRawEntry),
      ]
      setRawInactivePlacements(prev => ({ ...prev, [currentPid]: snapshot }))
    }
    // If we have cached data for the incoming variant, seed it immediately to avoid blank frames
    const newPid = variants[newIdx]?.id
    const cached = newPid ? rawInactivePlacements[newPid] : null
    if (cached?.length) {
      // Seed synchronously. The load effect will see the seededPipelineIdRef match
      // and skip the SET_LOADING clear, avoiding a blank frame.
      brollState.seedFromCache(newPid, cached)
    }
    // selectIdentity may be: { chapterIndex, placementIndex, userPlacementId } object,
    // or a bare numeric index (legacy). Stash for the pending-selection effect to resolve
    // once the new variant's placements are loaded.
    if (selectIdentity != null) {
      pendingSelectionRef.current = selectIdentity
      pendingSelectionTsRef.current = Date.now()
    }
    setActiveVariantIdx(newIdx)
  }, [activeVariantIdx, variants, brollState.rawPlacements, brollState.userPlacements, brollState.seedFromCache, rawInactivePlacements, brollState.edits])

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
      // TODO: inactive variant edits — currently inactive variants don't have their edits applied
      //       because fetching per-pipeline editor-state for all variants is not yet wired up.
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

  // Apply pending selection after variant switch data loads. The pending value can be:
  //   - { chapterIndex, placementIndex, userPlacementId } — stable cross-variant identity (preferred)
  //   - bare number — legacy / direct-index path
  // Re-runs as placements/userPlacements change so userPlacement matches arrive after
  // LOAD_EDITOR_STATE populates state.userPlacements (which lands AFTER editor-data).
  useEffect(() => {
    const pending = pendingSelectionRef.current
    if (pending == null || brollState.loading || !brollState.placements?.length) return

    // TTL: if older than 5s, drop it — the data we expected never arrived.
    if (Date.now() - pendingSelectionTsRef.current > 5000) {
      pendingSelectionRef.current = null
      return
    }

    if (typeof pending === 'object') {
      let match = null
      if (pending.userPlacementId) {
        match = brollState.placements.find(p => p.userPlacementId === pending.userPlacementId)
      } else if (pending.chapterIndex != null && pending.placementIndex != null) {
        match = brollState.placements.find(p =>
          p.chapterIndex === pending.chapterIndex && p.placementIndex === pending.placementIndex
        )
      }
      if (match) {
        brollState.selectPlacement(match.index)
        pendingSelectionRef.current = null
      }
      return
    }

    brollState.selectPlacement(pending)
    pendingSelectionRef.current = null
  }, [activeVariantIdx, brollState.loading, brollState.placements])

  // Sync URL detail (placementId) → selection on mount / URL change
  useEffect(() => {
    if (!brollState.placements?.length) return
    const idx = resolveDetailToIndex(detail)
    if (idx != null && idx !== brollState.selectedIndex) {
      pendingSelectionRef.current = null  // user navigated, drop pending
      brollState.selectPlacement(idx)
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

  // Keyboard shortcuts — delete/backspace, undo/redo
  useEffect(() => {
    const handler = (e) => {
      // Ignore when user is typing in inputs
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return

      const isMac = navigator.platform.toLowerCase().includes('mac')
      const mod = isMac ? e.metaKey : e.ctrlKey

      // Delete / Backspace → delete selected placement
      if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && brollState.selectedIndex != null) {
        e.preventDefault()
        const placement = brollState.selectedPlacement
        brollState.hidePlacement(brollState.selectedIndex)
        brollState.selectPlacement(null)
        if (placement && placement.timelineStart != null) {
          editorCtx?.dispatch?.({ type: 'SET_CURRENT_TIME', payload: placement.timelineStart })
        }
        return
      }

      // CMD/Ctrl + C → copy selected
      if (mod && e.code === 'KeyC' && brollState.selectedIndex != null) {
        e.preventDefault()
        brollState.copyPlacement(brollState.selectedIndex)
        return
      }
      // CMD/Ctrl + X → cut selected
      if (mod && e.code === 'KeyX' && brollState.selectedIndex != null) {
        e.preventDefault()
        brollState.copyPlacement(brollState.selectedIndex, { cut: true })
        return
      }
      // CMD/Ctrl + V → paste after selected OR at playhead
      if (mod && e.code === 'KeyV') {
        e.preventDefault()
        let targetStart
        if (brollState.selectedPlacement) {
          targetStart = brollState.selectedPlacement.timelineEnd + 0.05
        } else if (editorCtx?.state?.currentTime != null) {
          targetStart = editorCtx.state.currentTime
        } else {
          targetStart = 0
        }
        brollState.pastePlacement(targetStart)
        return
      }

      // CMD/Ctrl + Z (without Shift) → undo
      if (mod && !e.shiftKey && e.code === 'KeyZ') {
        e.preventDefault()
        brollState.undo()
        return
      }

      // CMD/Ctrl + Shift + Z (or CMD/Ctrl + Y on Windows) → redo
      if ((mod && e.shiftKey && e.code === 'KeyZ') || (mod && e.code === 'KeyY')) {
        e.preventDefault()
        brollState.redo()
        return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [brollState.selectedIndex, brollState.hidePlacement, brollState.selectPlacement, brollState.undo, brollState.redo, brollState.copyPlacement, brollState.pastePlacement, brollState.selectedPlacement, editorCtx])

  // Preload next few b-roll clips on the active variant and inactive variants.
  useEffect(() => {
    scheduleBrollPreload({
      activePlacements: brollState.placements || [],
      inactivePlacementsByPid: inactiveVariantPlacements || {},
      currentTime: editorCtx?.state?.currentTime || 0,
      selectedResultsByIndex: brollState.selectedResults || {},
    })
  }, [brollState.placements, inactiveVariantPlacements, editorCtx?.state?.currentTime, brollState.selectedResults])

  // Clean up preload tags on unmount
  useEffect(() => () => clearBrollPreload(), [])

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
            className="h-2 w-full flex items-center justify-center group relative z-40 shrink-0 cursor-ns-resize"
            onMouseDown={onMouseDown}
          >
            <div className="w-full h-px bg-white/5 group-hover:bg-primary-fixed/30 transition-colors" />
            <div className="absolute w-10 h-1 bg-outline-variant/50 rounded-full group-hover:bg-primary-fixed group-hover:shadow-[0_0_10px_rgba(206,252,0,0.5)] transition-all" />
          </div>

          {/* Bottom: playback controls + timeline */}
          <div className="flex flex-col gap-1 shrink-0" style={{ height: `${bottomH}px` }}>
            <PlaybackControls />
            <div className="flex-1 min-h-0">
              <Timeline
                variants={variants}
                activeVariantIdx={activeVariantIdx}
                onVariantActivate={handleVariantActivate}
                inactiveVariantPlacements={inactiveVariantPlacements}
                onCrossDrop={async (args) => {
                  // Determine source duration and target's existing placements (for gap-fit).
                  const sourcePlacement = brollState.placements.find(p => p.index === args.sourceIndex)
                  const sourceDur = Math.max(0.5, sourcePlacement?.timelineDuration || 1)
                  const targetIsActive = args.targetPipelineId === variants[activeVariantIdx]?.id

                  // For inactive targets, refresh from server right before the fit-check so the
                  // gap math is current. The 5s fetchInactive interval only runs while a search
                  // is active, so cached data can be stale (or missing entirely if the initial
                  // fetch silently failed). Without this refresh, computeFitDropPosition runs
                  // against `[]` → infinite gap → drops succeed in occupied space.
                  //
                  // We also merge any locally-cached optimistic synthetics (from prior drops in
                  // this session whose PUT may not have committed yet on the server) so two
                  // rapid drops into the same gap don't both pass fit-check and overlap.
                  let targetPlacements
                  if (targetIsActive) {
                    targetPlacements = brollState.placements
                  } else {
                    try {
                      const data = await authFetchBRollData(args.targetPipelineId)
                      const serverPlacements = data.placements || []
                      const serverIds = new Set(serverPlacements.filter(p => p.userPlacementId).map(p => p.userPlacementId))
                      const localOptimistic = (rawInactivePlacements[args.targetPipelineId] || [])
                        .filter(p => p.isUserPlacement && p.userPlacementId && !serverIds.has(p.userPlacementId))
                      const merged = [...serverPlacements, ...localOptimistic]
                      targetPlacements = matchPlacementsToTranscript(merged, transcriptWords)
                      setRawInactivePlacements(prev => ({ ...prev, [args.targetPipelineId]: merged }))
                    } catch (err) {
                      console.error('[broll-cross-drop] fit-check refresh failed:', err.message)
                      window.alert('Could not load target variant. Try again in a moment.')
                      return
                    }
                  }

                  const adjusted = computeFitDropPosition(targetPlacements, args.targetStartSec, sourceDur)
                  if (!adjusted) {
                    window.alert('Not enough space at this drop position.')
                    return
                  }

                  // Generate the userPlacement uuid up-front so the optimistic insert and
                  // the server-saved entry share one id — React reconciles by key, no remount
                  // when the eventual refetch replaces the synthetic with the server version.
                  const uuid = 'u_' + (crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12)

                  // Optimistic insert: target is always inactive (handleBoxMove only triggers
                  // cross-mode when the dragged-over row differs from active). Insert a synthetic
                  // entry matching the server's merged shape so the b-roll is visible immediately
                  // and the gap-fit logic for subsequent drops sees it.
                  const resultIdx = brollState.selectedResults?.[args.sourceIndex] ?? sourcePlacement.persistedSelectedResult ?? 0
                  const synthetic = userPlacementToRawEntry({
                    id: uuid,
                    sourcePipelineId: variants[activeVariantIdx]?.id,
                    sourceChapterIndex: sourcePlacement.chapterIndex ?? null,
                    sourcePlacementIndex: sourcePlacement.placementIndex ?? null,
                    timelineStart: adjusted.start,
                    timelineEnd: adjusted.start + adjusted.duration,
                    selectedResult: resultIdx,
                    results: sourcePlacement.results || [],
                    snapshot: {
                      description: sourcePlacement.description,
                      audio_anchor: sourcePlacement.audio_anchor,
                      function: sourcePlacement.function,
                      type_group: sourcePlacement.type_group,
                      source_feel: sourcePlacement.source_feel,
                      style: sourcePlacement.style,
                    },
                  })
                  let optimisticInserted = false
                  if (!targetIsActive) {
                    setRawInactivePlacements(prev => ({
                      ...prev,
                      [args.targetPipelineId]: [...(prev[args.targetPipelineId] || []), synthetic],
                    }))
                    optimisticInserted = true
                  }

                  try {
                    await brollState.dragCrossPlacement({
                      ...args,
                      targetStartSec: adjusted.start,
                      targetDurationSec: adjusted.duration,
                      uuid,
                    })
                    // Skip the success-path refetch: the synthetic shares the server uuid and
                    // matches the server's merged shape, so the inactive view is already correct.
                    // A natural fetchInactive (variant switch or 5s search interval) will reconcile
                    // any later changes.
                  } catch (err) {
                    // Server write failed — revert the optimistic insert. dragCrossPlacement
                    // already reverted its source-side hide.
                    if (optimisticInserted) {
                      setRawInactivePlacements(prev => ({
                        ...prev,
                        [args.targetPipelineId]: (prev[args.targetPipelineId] || []).filter(p => p.userPlacementId !== uuid),
                      }))
                    }
                  }
                }}
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

// Find a drop position that fits the source clip without becoming too tiny to grab.
// If the gap to the right is < 0.5s, try shifting LEFT so the clip ends just before
// the next clip AND is at least 0.5s wide. Returns null if no fit is possible.
function computeFitDropPosition(placements, requestedStart, sourceDur) {
  const MIN_DUR = 0.5
  const sorted = [...placements]
    .filter(p => Number.isFinite(p.timelineStart) && Number.isFinite(p.timelineEnd))
    .sort((a, b) => a.timelineStart - b.timelineStart)

  // If requestedStart falls INSIDE an existing placement, snap to its end + 0.05.
  let start = Math.max(0, requestedStart)
  const inside = sorted.find(r => start >= r.timelineStart && start < r.timelineEnd)
  if (inside) start = inside.timelineEnd + 0.05

  // Find left and right neighbors relative to `start`.
  const next = sorted.find(r => r.timelineStart >= start)
  const prevs = sorted.filter(r => r.timelineEnd <= start)
  const prevEnd = prevs.length ? prevs[prevs.length - 1].timelineEnd : 0
  const rightBoundary = next ? next.timelineStart : Infinity

  const gapRight = rightBoundary - start
  if (gapRight >= MIN_DUR) {
    return { start, duration: Math.min(sourceDur, gapRight - 0.05) }
  }

  // Gap to right is too small — try shifting LEFT so the clip ends just before `next`
  // and has at least MIN_DUR.
  if (next) {
    const desiredEnd = next.timelineStart - 0.05
    const desiredDur = Math.min(sourceDur, MIN_DUR)
    const desiredStart = desiredEnd - desiredDur
    if (desiredStart >= prevEnd + 0.05) {
      // Try to grow the duration toward sourceDur if there's more room
      const maxDur = desiredEnd - (prevEnd + 0.05)
      const dur = Math.min(sourceDur, Math.max(MIN_DUR, maxDur))
      return { start: desiredEnd - dur, duration: dur }
    }
  }

  // No fit possible — caller will show "no space" toast.
  return null
}

