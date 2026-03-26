import { useState, useRef, useCallback, useEffect, useMemo, useContext } from 'react'
import { EditorContext } from './EditorView.jsx'

const ANNOTATION_COLORS = {
  // Deletions — red spectrum (dark → light)
  false_starts:      { bg: 'rgba(220, 38, 38, 0.15)',  border: '#dc2626', label: 'False Starts' },
  filler_words:      { bg: 'rgba(239, 68, 68, 0.15)',  border: '#ef4444', label: 'Filler Words' },
  meta_commentary:   { bg: 'rgba(251, 113, 133, 0.15)', border: '#fb7185', label: 'Meta Commentary' },
  // Identifications — purple/orange/warm
  repetition:        { bg: 'rgba(167, 139, 250, 0.20)', border: '#a78bfa', label: 'Repetition' },
  lengthy:           { bg: 'rgba(251, 191, 36, 0.20)',  border: '#fbbf24', label: 'Lengthy' },
  technical_unclear: { bg: 'rgba(251, 146, 60, 0.20)',  border: '#fb923c', label: 'Too Technical & Unclear' },
  irrelevance:       { bg: 'rgba(232, 121, 249, 0.20)', border: '#e879f9', label: 'Irrelevance' },
}

function formatGap(seconds) {
  const rounded = Math.round(seconds * 2) / 2 // nearest 0.5
  return rounded % 1 === 0 ? `[${rounded}s]` : `[${rounded.toFixed(1)}s]`
}

export default function TranscriptEditor() {
  const { state, dispatch, playbackEngine } = useContext(EditorContext)

  // Primary transcript: use the longest audio track's words as the single source.
  // Only fill in time gaps (ranges the primary doesn't cover) from other tracks.
  const mergedWords = useMemo(() => {
    const audioTracks = state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .map(t => ({
        track: t,
        timelineStart: t.offset,
        timelineEnd: t.offset + t.duration,
      }))
      .sort((a, b) => (b.timelineEnd - b.timelineStart) - (a.timelineEnd - a.timelineStart))

    if (!audioTracks.length) return []

    const primary = audioTracks[0]
    const words = primary.track.transcriptWords.map(w => ({
      word: w.word,
      start: w.start + primary.track.offset,
      end: w.end + primary.track.offset,
      trackId: primary.track.id,
    }))

    const coveredStart = primary.timelineStart
    const coveredEnd = primary.timelineEnd

    for (let i = 1; i < audioTracks.length; i++) {
      const t = audioTracks[i].track
      for (const w of t.transcriptWords) {
        const absStart = w.start + t.offset
        if (absStart < coveredStart || absStart >= coveredEnd) {
          words.push({ word: w.word, start: absStart, end: w.end + t.offset, trackId: t.id })
        }
      }
    }

    words.sort((a, b) => a.start - b.start)
    return words
  }, [state.tracks])

  // Build display items: words + silence gap markers (gaps > 1s)
  const displayItems = useMemo(() => {
    const items = []
    for (let i = 0; i < mergedWords.length; i++) {
      if (i > 0) {
        const gap = mergedWords[i].start - mergedWords[i - 1].end
        if (gap >= 1.0) {
          items.push({
            type: 'gap',
            word: formatGap(gap),
            start: mergedWords[i - 1].end,
            end: mergedWords[i].start,
            wordIdx: -1,
          })
        }
      }
      items.push({ type: 'word', ...mergedWords[i], wordIdx: i })
    }
    return items
  }, [mergedWords])

  // AI Smart Controls state (persisted in editor state)
  const cutsSelected = state.aiCutsSelected
  const identifySelected = state.aiIdentifySelected

  // Build annotation lookup: Map<displayItemIndex, annotation[]>
  const annotationMap = useMemo(() => {
    const map = new Map()
    if (!state.annotations?.items?.length) return map
    for (const ann of state.annotations.items) {
      // Skip identify annotations whose category is toggled OFF
      if (ann.type === 'identify' && !identifySelected[ann.category]) continue
      for (let i = 0; i < displayItems.length; i++) {
        const item = displayItems[i]
        if (item.type !== 'word') continue
        if (item.start < ann.endTime && item.end > ann.startTime) {
          if (!map.has(i)) map.set(i, [])
          map.get(i).push(ann)
        }
      }
    }
    return map
  }, [state.annotations, displayItems, identifySelected])

  // Category counts for legend
  const categoryCounts = useMemo(() => {
    if (!state.annotations?.items?.length) return {}
    const counts = {}
    for (const ann of state.annotations.items) {
      counts[ann.category] = (counts[ann.category] || 0) + 1
    }
    return counts
  }, [state.annotations])

  const [cutsOpen, setCutsOpen] = useState(false)
  const [identifyOpen, setIdentifyOpen] = useState(false)
  const cutsRef = useRef(null)
  const identifyRef = useRef(null)

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (cutsRef.current && !cutsRef.current.contains(e.target)) setCutsOpen(false)
      if (identifyRef.current && !identifyRef.current.contains(e.target)) setIdentifyOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // AI Cut Silences — transcript identifies gaps, waveform refines exact boundaries
  const silenceMountRef = useRef(true)
  useEffect(() => {
    // Skip initial mount — cuts are already restored from saved state
    if (silenceMountRef.current) {
      silenceMountRef.current = false
      return
    }

    if (!cutsSelected.silences) {
      dispatch({ type: 'SET_AI_CUTS', payload: { prefix: 'cut-ai-silence-', cuts: [] } })
      return
    }

    // Find primary audio track (longest — same logic as mergedWords)
    const primaryTrack = state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .sort((a, b) => b.duration - a.duration)[0]
    const peaks = primaryTrack?.waveformPeaks
    const PEAKS_PER_SEC = 100 // 10ms per bar
    const trackOffset = primaryTrack?.offset || 0

    // Check if a waveform bar at peak index b has visible sound — same logScale
    // as rough cut visualization (dB scaling, -60dB floor, barH >= 0.5 threshold)
    const hasSound = (b) => {
      if (!peaks || b < 0 || b * 2 + 1 >= peaks.length) return false
      const linear = Math.abs(peaks[b * 2 + 1]) / 128
      if (linear <= 0) return false
      const db = 20 * Math.log10(linear)
      const scaled = db <= -60 ? 0 : (db - -60) / 60
      return scaled >= 0.5 / 56 // barH >= 0.5 at track height 56px
    }

    // Convert timeline time to peak index (local to track)
    const timeToPeak = (t) => Math.round((t - trackOffset) * PEAKS_PER_SEC)

    const cuts = []
    for (let i = 1; i < mergedWords.length; i++) {
      const gap = mergedWords[i].start - mergedWords[i - 1].end
      if (gap <= 0.75) continue

      let cutStart = mergedWords[i - 1].end
      let cutEnd = mergedWords[i].start - 0.2

      if (peaks?.length) {
        const prevEndBar = timeToPeak(mergedWords[i - 1].end)
        const nextStartBar = timeToPeak(mergedWords[i].start)

        // Cut START: check waveform at prev word's end time.
        // If still sound → scan forward to where it goes silent.
        // If already silent → scan backward to find where sound actually ended
        //   (handles inflated transcript end times). Add 200ms after last sound.
        if (hasSound(prevEndBar)) {
          let b = prevEndBar
          while (b < nextStartBar && hasSound(b)) b++
          cutStart = trackOffset + b / PEAKS_PER_SEC + 0.1 // 100ms padding after last sound
        } else {
          const prevStartBar = timeToPeak(mergedWords[i - 1].start)
          let b = prevEndBar
          while (b > prevStartBar && !hasSound(b)) b--
          if (b > prevStartBar) {
            cutStart = trackOffset + (b + 1) / PEAKS_PER_SEC + 0.2
          }
        }

        // Cut END: check waveform at next word's transcript start.
        // If silent → scan right to find first real sound (3 consecutive bars).
        // Cut ends 200ms before that sound.
        // Cap scan at 500ms past transcript start — if no sound found, trust transcript.
        if (!hasSound(nextStartBar)) {
          let b = nextStartBar
          const limit = nextStartBar + 50 // scan up to 500ms forward
          let found = false
          while (b < limit) {
            if (hasSound(b) && hasSound(b + 1) && hasSound(b + 2)) {
              cutEnd = trackOffset + b / PEAKS_PER_SEC - 0.2
              found = true
              break
            }
            b++
          }
          if (!found) cutEnd = mergedWords[i].start - 0.2
        }
        // else: sound already at transcript start → cutEnd stays at nextWord.start - 0.2
      }

      if (cutEnd > cutStart + 0.1) {
        cuts.push({
          id: `cut-ai-silence-${i}`,
          start: cutStart,
          end: cutEnd,
          source: 'ai-silence',
        })
      }
    }
    dispatch({ type: 'SET_AI_CUTS', payload: { prefix: 'cut-ai-silence-', cuts } })
  }, [cutsSelected.silences, mergedWords, state.tracks, dispatch])

  // AI Cut Annotations — wire deletion checkboxes to annotation cuts
  const annCutMountRef = useRef(true)
  useEffect(() => {
    if (annCutMountRef.current) { annCutMountRef.current = false; return }
    for (const category of ['false_starts', 'filler_words', 'meta_commentary']) {
      const prefix = `cut-ai-ann-${category}-`
      if (!cutsSelected[category]) {
        dispatch({ type: 'SET_AI_CUTS', payload: { prefix, cuts: [] } })
        continue
      }
      const cuts = (state.annotations?.items || [])
        .filter(a => a.type === 'deletion' && a.category === category)
        .map(ann => ({ id: `${prefix}${ann.id}`, start: ann.startTime, end: ann.endTime, source: 'annotation', annotationId: ann.id }))
      dispatch({ type: 'SET_AI_CUTS', payload: { prefix, cuts } })
    }
  }, [cutsSelected.false_starts, cutsSelected.filler_words, cutsSelected.meta_commentary, state.annotations, dispatch])

  // Selection state — displayItems indices after snap
  const [selStart, setSelStart] = useState(-1)
  const [selEnd, setSelEnd] = useState(-1)
  const [isSelecting, setIsSelecting] = useState(false)
  const containerRef = useRef(null)
  const itemRefs = useRef([])

  // Tooltip state
  const [tooltip, setTooltip] = useState(null) // {x, y, annotations}

  // Check if an item overlaps any cut region
  const isItemCut = useCallback((item) => {
    return state.cuts.some(c => item.start < c.end && item.end > c.start)
  }, [state.cuts])

  // Clear selection when playback starts
  useEffect(() => {
    if (state.isPlaying) {
      setSelStart(-1)
      setSelEnd(-1)
      dispatch({ type: 'SET_TRANSCRIPT_SELECTION', payload: null })
    }
  }, [state.isPlaying, dispatch])

  // Current display item index — highlights the word or gap marker at currentTime
  const currentItemIdx = useMemo(() => {
    if (!displayItems.length) return -1
    let lo = 0, hi = displayItems.length - 1, result = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (displayItems[mid].start <= state.currentTime) { result = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    return result
  }, [displayItems, state.currentTime])

  // Auto-scroll to current item during playback
  useEffect(() => {
    if (currentItemIdx < 0 || !containerRef.current) return
    const el = itemRefs.current[currentItemIdx]
    if (!el) return
    const container = containerRef.current
    const rect = el.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    if (rect.top < containerRect.top + 20 || rect.bottom > containerRect.bottom - 20) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [currentItemIdx])

  // Start native text selection on mousedown
  const handleMouseDown = useCallback(() => {
    setIsSelecting(true)
  }, [])

  // On mouseup: read native selection, snap to whole items, replace with highlight
  useEffect(() => {
    if (!isSelecting) return
    const onUp = () => {
      setIsSelecting(false)
      const selection = window.getSelection()
      let minIdx = -1, maxIdx = -1

      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        itemRefs.current.forEach((el, idx) => {
          if (el && range.intersectsNode(el)) {
            if (minIdx === -1) minIdx = idx
            maxIdx = idx
          }
        })
      }

      selection?.removeAllRanges()

      if (minIdx >= 0 && maxIdx >= 0) {
        setSelStart(minIdx)
        setSelEnd(maxIdx)
        dispatch({
          type: 'SET_TRANSCRIPT_SELECTION',
          payload: { startTime: displayItems[minIdx].start, endTime: displayItems[maxIdx].end },
        })

        // Single word tap — also seek
        if (minIdx === maxIdx && displayItems[minIdx].type === 'word') {
          dispatch({ type: 'SET_CURRENT_TIME', payload: displayItems[minIdx].start })
          playbackEngine.current?.seek(displayItems[minIdx].start)
        }
      } else {
        setSelStart(-1)
        setSelEnd(-1)
        dispatch({ type: 'SET_TRANSCRIPT_SELECTION', payload: null })
      }
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [isSelecting, displayItems, dispatch, playbackEngine])

  const selMin = Math.min(selStart, selEnd)
  const selMax = Math.max(selStart, selEnd)
  const hasSelection = selStart >= 0 && selEnd >= 0

  // Count only words in selection for header
  const selectedWordCount = useMemo(() => {
    if (!hasSelection) return 0
    let count = 0
    for (let i = selMin; i <= selMax; i++) {
      if (displayItems[i]?.type === 'word') count++
    }
    return count
  }, [hasSelection, selMin, selMax, displayItems])

  // Remove cut on right-click
  const handleContextMenu = useCallback((idx, e) => {
    e.preventDefault()
    const item = displayItems[idx]
    const cut = state.cuts.find(c => item.start < c.end && item.end > c.start)
    if (cut) {
      dispatch({ type: 'REMOVE_CUT', payload: cut.id })
    }
  }, [displayItems, state.cuts, dispatch])

  // Tooltip handlers
  const handleMouseEnter = useCallback((idx, e) => {
    const anns = annotationMap.get(idx)
    if (!anns?.length) return
    const rect = e.currentTarget.getBoundingClientRect()
    setTooltip({
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
      annotations: anns,
    })
  }, [annotationMap])

  const handleMouseLeave = useCallback(() => {
    setTooltip(null)
  }, [])

  const hasAnnotations = Object.keys(categoryCounts).length > 0

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-sm text-primary-fixed" style={{ fontVariationSettings: '"FILL" 1' }}>text_fields</span>
          <span className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Transcript</span>
        </div>
        {hasSelection && (
          <span className="text-[10px] text-on-surface-variant/60">
            {selectedWordCount > 0 ? `${selectedWordCount} word${selectedWordCount !== 1 ? 's' : ''} selected — ` : ''}press Backspace to cut
          </span>
        )}
        {state.cuts.length > 0 && (
          <span className="text-[10px] text-on-surface-variant/60">
            {state.cuts.length} cut{state.cuts.length !== 1 ? 's' : ''} — right-click cut text to remove
          </span>
        )}
      </div>

      {/* AI Smart Controls */}
      <div className="flex items-center gap-2 px-5 py-2 border-b border-white/5 shrink-0">
        {/* AI Cuts Dropdown */}
        <div className="relative" ref={cutsRef}>
          <button
            onClick={() => { setCutsOpen(o => !o); setIdentifyOpen(false) }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-xs font-bold text-on-surface-variant/80 hover:text-primary-fixed border border-white/10 transition-all"
          >
            <span className="material-symbols-outlined text-[16px]">auto_videocam</span>
            AI Cuts
            <span className="material-symbols-outlined text-[16px] opacity-40">expand_more</span>
          </button>
          {cutsOpen && (
            <div
              className="absolute top-full left-0 mt-1 w-52 rounded-md py-1 z-[60]"
              style={{ background: '#19191c', border: '1px solid rgba(206,252,0,0.1)', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5)' }}
            >
              {[
                ['silences', 'Cut silences'],
                ['false_starts', 'Cut false starts'],
                ['filler_words', 'Cut filler words'],
                ['meta_commentary', 'Cut meta commentary'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => dispatch({ type: 'SET_AI_CUTS_SELECTED', payload: { [key]: !cutsSelected[key] } })}
                  className="flex items-center gap-3 w-full px-4 py-2 text-[11px] text-on-surface-variant/70 hover:bg-primary-fixed/10 hover:text-primary-fixed transition-colors"
                >
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                    cutsSelected[key] ? 'bg-primary-fixed border-primary-fixed' : 'border-white/20'
                  }`}>
                    {cutsSelected[key] && <span className="material-symbols-outlined text-[12px] text-on-primary-fixed">check</span>}
                  </span>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* AI Identify Dropdown */}
        <div className="relative" ref={identifyRef}>
          <button
            onClick={() => { setIdentifyOpen(o => !o); setCutsOpen(false) }}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-xs font-bold text-on-surface-variant/80 hover:text-primary-fixed border border-white/10 transition-all"
          >
            <span className="material-symbols-outlined text-[16px]">visibility</span>
            AI Identify
            <span className="material-symbols-outlined text-[16px] opacity-40">expand_more</span>
          </button>
          {identifyOpen && (
            <div
              className="absolute top-full left-0 mt-1 w-64 rounded-md py-1 z-[60]"
              style={{ background: '#19191c', border: '1px solid rgba(206,252,0,0.1)', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.5)' }}
            >
              {[
                ['repetition', 'Repetitive Parts'],
                ['lengthy', 'Over-explanation & lengthy parts'],
                ['technical_unclear', 'Too technical & unclear parts'],
                ['irrelevance', 'Irrelevant parts'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => dispatch({ type: 'SET_AI_IDENTIFY_SELECTED', payload: { [key]: !identifySelected[key] } })}
                  className="flex items-center gap-3 w-full px-4 py-2 text-[11px] text-on-surface-variant/70 hover:bg-primary-fixed/10 hover:text-primary-fixed transition-colors"
                >
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
                    identifySelected[key] ? 'bg-primary-fixed border-primary-fixed' : 'border-white/20'
                  }`}>
                    {identifySelected[key] && <span className="material-symbols-outlined text-[12px] text-on-primary-fixed">check</span>}
                  </span>
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Annotation legend */}
      {hasAnnotations && (
        <div className="flex items-center gap-3 px-5 py-2 border-b border-white/5 shrink-0 overflow-x-auto">
          {Object.entries(categoryCounts).map(([category, count]) => {
            const colors = ANNOTATION_COLORS[category]
            if (!colors) return null
            return (
              <div key={category} className="flex items-center gap-1.5 shrink-0">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: colors.border }} />
                <span className="text-[10px] text-on-surface-variant/70">{colors.label}</span>
                <span className="text-[10px] text-on-surface-variant/40">{count}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Word flow */}
      <div ref={containerRef} className="flex-1 overflow-auto px-5 py-4">
        <style>{`.transcript-words ::selection { background: rgba(206, 252, 0, 0.4); color: inherit; }`}</style>
        <div className="transcript-words leading-[2.2] text-[13px] text-on-surface" onMouseDown={handleMouseDown}>
          {displayItems.map((item, idx) => {
            const cut = isItemCut(item)
            const selected = hasSelection && idx >= selMin && idx <= selMax
            const isCurrent = idx === currentItemIdx
            const isGap = item.type === 'gap'
            const anns = annotationMap.get(idx)
            const hasAnn = anns?.length > 0
            const primaryAnn = hasAnn ? anns[0] : null
            const annColors = primaryAnn ? ANNOTATION_COLORS[primaryAnn.category] : null

            // Determine background color
            let bgColor = undefined
            if (selected) {
              bgColor = 'rgba(206, 252, 0, 0.3)'
            } else if (annColors && !isGap) {
              bgColor = annColors.bg
            }

            // Determine if this should have strikethrough from annotation
            const isDeletion = hasAnn && primaryAnn.type === 'deletion'

            return (
              <span
                key={`${item.start}-${idx}`}
                ref={el => itemRefs.current[idx] = el}
                className={`cursor-text px-[1px] py-[2px] inline ${
                  (cut || isDeletion) ? 'line-through text-on-surface-variant' : ''
                } ${
                  cut && !selected ? 'opacity-30' : ''
                } ${
                  isCurrent && !cut && !bgColor ? 'bg-white/15' : ''
                } ${
                  isGap && !cut ? 'text-on-surface-variant/40 text-[11px]' : ''
                }`}
                style={bgColor ? { backgroundColor: bgColor } : undefined}
                onContextMenu={(e) => handleContextMenu(idx, e)}
                onMouseEnter={hasAnn ? (e) => handleMouseEnter(idx, e) : undefined}
                onMouseLeave={hasAnn ? handleMouseLeave : undefined}
              >
                {item.word}{' '}
              </span>
            )
          })}
          {displayItems.length === 0 && (
            <div className="text-on-surface-variant/40 text-sm italic mt-8 text-center">
              No transcript available yet.
            </div>
          )}
        </div>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-[200] pointer-events-none"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="bg-[#1a1a1e] border border-white/10 rounded-lg px-3 py-2 shadow-xl max-w-xs">
            {tooltip.annotations.map((ann, i) => {
              const colors = ANNOTATION_COLORS[ann.category]
              return (
                <div key={ann.id} className={i > 0 ? 'mt-1.5 pt-1.5 border-t border-white/5' : ''}>
                  <div className="flex items-center gap-1.5">
                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: colors?.border || '#888' }} />
                    <span className="text-[10px] font-semibold" style={{ color: colors?.border || '#888' }}>
                      {colors?.label || ann.category}
                    </span>
                    <span className="text-[9px] text-on-surface-variant/40">{ann.type === 'deletion' ? 'cut' : 'flag'}</span>
                  </div>
                  {ann.reason && (
                    <p className="text-[10px] text-on-surface-variant/70 mt-0.5 leading-tight">{ann.reason}</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
