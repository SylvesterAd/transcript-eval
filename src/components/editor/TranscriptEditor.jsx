import { useState, useRef, useCallback, useEffect, useMemo, useContext } from 'react'
import { EditorContext } from './EditorView.jsx'

const ANNOTATION_COLORS = {
  // Deletions — red spectrum (dark → light)
  false_starts:      { bg: 'rgba(220, 38, 38, 0.15)',  border: '#dc2626', label: 'False Starts' },
  filler_words:      { bg: 'rgba(251, 146, 60, 0.15)',  border: '#fb923c', label: 'Filler Words' },
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
  const { state, dispatch, playbackEngine, cutDragRef } = useContext(EditorContext)

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

    // Correct word start/end times using waveform data
    // (transcription timestamps can be inaccurate — waveform shows where sound actually is)
    const primaryTrack = primary.track
    const peaks = primaryTrack?.waveformPeaks
    if (peaks?.length) {
      const PEAKS_PER_SEC = 100
      const offset = primaryTrack.offset || 0
      const timeToPeak = (t) => Math.round((t - offset) * PEAKS_PER_SEC)
      const hasSound = (b) => {
        if (b < 0 || b * 2 + 1 >= peaks.length) return false
        const linear = Math.abs(peaks[b * 2 + 1]) / 128
        if (linear <= 0) return false
        const db = 20 * Math.log10(linear)
        const scaled = db <= -60 ? 0 : (db - -60) / 60
        return scaled >= 0.5 / 56
      }

      // First pass: correct suspiciously long word durations regardless of gap
      // (ElevenLabs sometimes inflates end times, hiding silence inside a word)
      for (let i = 0; i < words.length; i++) {
        const duration = words[i].end - words[i].start
        if (duration > 0.5) {
          const wordEndBar = timeToPeak(words[i].end)
          const wordStartBar = timeToPeak(words[i].start)
          // Scan backward from word end to find where sound actually stops
          let b = wordEndBar
          while (b > wordStartBar && !hasSound(b)) b--
          if (b > wordStartBar) {
            let corrected = Math.max(offset + (b + 1) / PEAKS_PER_SEC + 0.15, words[i].start + 0.15)
            // Never extend past the next word's start
            if (i < words.length - 1) corrected = Math.min(corrected, words[i + 1].start)
            words[i].end = corrected
          }
        }
      }

      // Second pass: correct word boundaries at silence gaps
      for (let i = 1; i < words.length; i++) {
        const gap = words[i].start - words[i - 1].end
        const nextStartBar = timeToPeak(words[i].start)

        // Correct previous word's end time (only for larger gaps to avoid tight sequences)
        if (gap > 0.75) {
          const prevEndBar = timeToPeak(words[i - 1].end)
          const prevStartBar = timeToPeak(words[i - 1].start)
          if (hasSound(prevEndBar)) {
            let b = prevEndBar
            while (b < nextStartBar && hasSound(b)) b++
            words[i - 1].end = Math.max(offset + b / PEAKS_PER_SEC + 0.15, words[i - 1].start + 0.15)
          } else {
            let b = prevEndBar
            while (b > prevStartBar && !hasSound(b)) b--
            if (b > prevStartBar) {
              words[i - 1].end = Math.max(offset + (b + 1) / PEAKS_PER_SEC + 0.15, words[i - 1].start + 0.15)
            }
          }
        }

        // Correct next word's start time (for any gap > 0.3s — catches annotation boundaries)
        if (gap > 0.3) {
          const prevCorrectedEndBar = timeToPeak(words[i - 1].end)
          if (hasSound(nextStartBar)) {
            // Scan backward to find 3 consecutive silent bars (ignores noise spikes)
            let b = nextStartBar
            const scanLimit = Math.max(nextStartBar - 50, prevCorrectedEndBar)
            while (b > scanLimit) {
              if (!hasSound(b) && !hasSound(b - 1) && !hasSound(b - 2)) break
              b--
            }
            words[i].start = offset + (b + 1) / PEAKS_PER_SEC - 0.05 // 50ms before first bar
          } else {
            let b = nextStartBar
            const limit = nextStartBar + 50
            while (b < limit) {
              if (hasSound(b) && hasSound(b + 1) && hasSound(b + 2)) {
                words[i].start = offset + b / PEAKS_PER_SEC - 0.05 // 50ms before first bar
                break
              }
              b++
            }
          }
        }
      }
    }

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
      // (Deletion annotations always show highlight; strikethrough controlled separately)
      if (ann.type === 'identify' && !identifySelected[ann.category]) continue
      for (let i = 0; i < displayItems.length; i++) {
        const item = displayItems[i]
        if (item.type !== 'word') continue
        const mid = (item.start + item.end) / 2
        if (mid >= ann.startTime && mid < ann.endTime) {
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

  // Check if a filler word has a silence gap (3 consecutive 0-bars) after it — safe to cut
  const fillerHasSilence = useMemo(() => {
    const primaryAudio = state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .sort((a, b) => b.duration - a.duration)[0]
    const peaks = primaryAudio?.waveformPeaks
    if (!peaks?.length) return () => true // no waveform = assume safe
    const trackOffset = primaryAudio.offset || 0
    const PEAKS_PER_SEC = 100
    const timeToPeak = (t) => Math.round((t - trackOffset) * PEAKS_PER_SEC)
    const hasSound = (b) => {
      if (b < 0 || b * 2 + 1 >= peaks.length) return false
      const linear = Math.abs(peaks[b * 2 + 1]) / 128
      if (linear <= 0) return false
      return (20 * Math.log10(linear) + 60) / 60 >= 0.5 / 56
    }
    return (ann) => {
      // Scan backward from filler start, look for 3 consecutive silent bars within 500ms
      const startBar = timeToPeak(ann.startTime)
      const limitBack = startBar - 50
      for (let b = startBar; b > limitBack; b--) {
        if (!hasSound(b) && !hasSound(b - 1) && !hasSound(b - 2)) return true
      }
      // Also scan forward from filler end
      const endBar = timeToPeak(ann.endTime)
      const limitFwd = endBar + 50
      for (let b = endBar; b < limitFwd; b++) {
        if (!hasSound(b) && !hasSound(b + 1) && !hasSound(b + 2)) return true
      }
      return false
    }
  }, [state.tracks])

  // Set of filler annotation IDs that have NO silence gap (show as yellow, not cut)
  const unsafeFillerIds = useMemo(() => {
    if (!state.annotations?.items?.length || !cutsSelected.filler_words) return new Set()
    const ids = new Set()
    for (const ann of state.annotations.items) {
      if (ann.type === 'deletion' && ann.category === 'filler_words') {
        if (!fillerHasSilence(ann)) ids.add(ann.id)
      }
    }
    return ids
  }, [state.annotations, cutsSelected.filler_words, fillerHasSilence])

  // Merged annotation cut regions (used by both silence and annotation cut effects)
  const annotationRegions = useMemo(() => {
    if (!state.annotations?.items?.length) return []
    const allCuts = []
    for (const category of ['false_starts', 'filler_words', 'meta_commentary']) {
      if (!cutsSelected[category]) continue
      for (const ann of state.annotations.items) {
        if (ann.type === 'deletion' && ann.category === category) {
          // Skip filler words without silence gap — they get yellow highlight instead
          if (category === 'filler_words' && unsafeFillerIds.has(ann.id)) continue
          allCuts.push({ start: ann.startTime, end: ann.endTime })
        }
      }
    }
    if (!allCuts.length) return []
    allCuts.sort((a, b) => a.start - b.start)
    const regions = [{ ...allCuts[0] }]
    for (let i = 1; i < allCuts.length; i++) {
      const last = regions[regions.length - 1]
      if (allCuts[i].start <= last.end) last.end = Math.max(last.end, allCuts[i].end)
      else regions.push({ ...allCuts[i] })
    }
    return regions
  }, [state.annotations, cutsSelected.false_starts, cutsSelected.filler_words, cutsSelected.meta_commentary])

  // AI Cut Silences — transcript identifies gaps, waveform refines exact boundaries
  const silenceMountRef = useRef(true)
  useEffect(() => {
    if (silenceMountRef.current) {
      silenceMountRef.current = false
      return
    }
    if (cutDragRef?.current) return // Don't regenerate during edge drag

    if (!cutsSelected.silences) {
      dispatch({ type: 'SET_AI_CUTS', payload: { prefix: 'cut-ai-silence-', cuts: [] } })
      return
    }

    // Word timestamps are already corrected by waveform in mergedWords useMemo.
    // Silence cuts simply span the gaps between corrected word boundaries.
    const exclusions = state.cutExclusions || []
    const cuts = []
    for (let i = 1; i < mergedWords.length; i++) {
      const gap = mergedWords[i].start - mergedWords[i - 1].end
      if (gap <= 0.75) continue

      const cutStart = mergedWords[i - 1].end + 0.1
      const cutEnd = mergedWords[i].start - 0.2

      // Skip silence cuts that overlap with manual exclusions
      const excluded = exclusions.some(ex => cutStart < ex.end && cutEnd > ex.start)
      if (excluded) continue

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
  }, [cutsSelected.silences, mergedWords, state.tracks, state.cutExclusions, dispatch])

  // AI Cut Annotations — merge adjacent annotation regions (bridging wordless
  // gaps), apply head/tail trim and exclusions, emit as continuous cut regions.
  useEffect(() => {
    if (cutDragRef?.current) return // Don't regenerate during edge drag
    if (!annotationRegions.length || !mergedWords.length) {
      dispatch({ type: 'SET_AI_CUTS', payload: { prefix: 'cut-ai-ann-', cuts: [] } })
      dispatch({ type: 'SET_AI_CUTS', payload: { prefix: 'cut-ai-bridge-', cuts: [] } }) // clean legacy
      return
    }

    const regions = annotationRegions.map(r => ({ ...r }))

    // Merge adjacent regions when no uncut word exists in the gap between them
    const merged = [{ ...regions[0] }]
    for (let i = 1; i < regions.length; i++) {
      const last = merged[merged.length - 1]
      const gapStart = last.end
      const gapEnd = regions[i].start
      const gapSize = gapEnd - gapStart

      const hasUncutWord = mergedWords.some(w => {
        const wEnd = Math.max(w.end, w.start + 0.01) // handle 0-duration words
        if (w.start >= gapEnd || wEnd <= gapStart) return false
        // Word is "cut" if it overlaps any annotation region (with 50ms tolerance for timestamp mismatches)
        return !regions.some(r => w.start >= r.start - 0.05 && wEnd <= r.end + 0.05)
      })
      const shouldMerge = !hasUncutWord

      if (shouldMerge) {
        last.end = regions[i].end
      } else {
        merged.push({ ...regions[i] })
      }
    }

    // Head trim: if first word is cut, extend to start of timeline
    const firstWord = mergedWords[0]
    if (firstWord && merged[0].start <= firstWord.start + 0.05) {
      merged[0].start = 0
    }

    // Tail trim: if last word is cut, extend to end of timeline
    const lastWord = mergedWords[mergedWords.length - 1]
    const lastMerged = merged[merged.length - 1]
    const timelineEnd = Math.max(...state.tracks.map(t => (t.offset || 0) + (t.duration || 0)))
    if (lastWord && lastMerged.end >= lastWord.end - 0.05 && timelineEnd > lastMerged.end) {
      lastMerged.end = timelineEnd
    }

    // Split merged cuts around excluded words
    let splits = merged
    if (state.cutExclusions?.length) {
      const exclusions = [...state.cutExclusions].sort((a, b) => a.start - b.start)
      splits = []
      for (const region of merged) {
        let current = { ...region }
        for (const ex of exclusions) {
          if (ex.start >= current.end || ex.end <= current.start) continue
          // Exclusion overlaps this region — split it
          if (current.start < ex.start - 0.01) {
            splits.push({ start: current.start, end: ex.start })
          }
          current.start = ex.end
        }
        if (current.start < current.end - 0.01) {
          splits.push(current)
        }
      }
    }

    // Bridge adjacent annotation cuts when no uncut words exist in the gap
    // (covers silence gaps between consecutive deleted sections)
    // Never bridge across exclusion zones — those are manual edits.
    const exclusions = state.cutExclusions || []
    const bridged = [{ ...splits[0] }]
    for (let i = 1; i < splits.length; i++) {
      const last = bridged[bridged.length - 1]
      const gapStart = last.end
      const gapEnd = splits[i].start
      // Don't bridge if an exclusion zone exists in the gap
      const crossesExclusion = exclusions.some(ex => ex.start < gapEnd && ex.end > gapStart)
      if (crossesExclusion) {
        bridged.push({ ...splits[i] })
        continue
      }
      const hasUncutWordInGap = mergedWords.some(w => {
        const wEnd = Math.max(w.end, w.start + 0.01)
        if (w.start < gapStart || wEnd > gapEnd) return false
        const isCoveredByAnn = annotationRegions.some(r => w.start >= r.start - 0.05 && wEnd <= r.end + 0.05)
        return !isCoveredByAnn
      })
      if (!hasUncutWordInGap) {
        last.end = splits[i].end
      } else {
        bridged.push({ ...splits[i] })
      }
    }

    // Extend annotation cut edges to fill wordless gaps (micro-gaps between
    // annotation cuts and silence cuts). Only extend into gaps with no uncut words —
    // never extend past the nearest uncut word boundary or exclusion zone.
    for (const region of bridged) {
      // Extend end forward: stretch to next uncut word's start (fills gap after last deleted word)
      const nextUncutWord = mergedWords.find(w => w.start >= region.end - 0.01 && !annotationRegions.some(r => w.start >= r.start - 0.05 && w.end <= r.end + 0.05))
      if (nextUncutWord) {
        const hasUncutBetween = mergedWords.some(w => {
          if (w === nextUncutWord) return false
          const wEnd = Math.max(w.end, w.start + 0.01)
          return w.start >= region.end - 0.01 && wEnd <= nextUncutWord.start + 0.01 &&
            !annotationRegions.some(r => w.start >= r.start - 0.05 && wEnd <= r.end + 0.05)
        })
        if (!hasUncutBetween) {
          let newEnd = nextUncutWord.start
          // Never extend into an exclusion zone
          for (const ex of exclusions) {
            if (ex.start > region.end - 0.01 && ex.start < newEnd) newEnd = Math.min(newEnd, ex.start)
          }
          region.end = newEnd
        }
      }
      // Extend start backward: stretch to prev uncut word's end (fills gap before first deleted word)
      const prevUncutWord = [...mergedWords].reverse().find(w => w.end <= region.start + 0.01 && !annotationRegions.some(r => w.start >= r.start - 0.05 && w.end <= r.end + 0.05))
      if (prevUncutWord) {
        let newStart = prevUncutWord.end
        // Never extend into an exclusion zone
        for (const ex of exclusions) {
          if (ex.end < region.start + 0.01 && ex.end > newStart) newStart = Math.max(newStart, ex.end)
        }
        region.start = Math.max(newStart, prevUncutWord.end)
      }
    }

    const finalCuts = bridged.map((r, i) => ({
      id: `cut-ai-ann-${i}`,
      start: r.start,
      end: r.end,
      source: 'annotation',
    }))

    dispatch({ type: 'SET_AI_CUTS', payload: { prefix: 'cut-ai-ann-', cuts: finalCuts } })
    dispatch({ type: 'SET_AI_CUTS', payload: { prefix: 'cut-ai-bridge-', cuts: [] } }) // clean legacy
  }, [annotationRegions, mergedWords, state.tracks, state.cutExclusions, dispatch])

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
    return state.cuts.some(c => c.end > c.start + 0.01 && item.start < c.end && item.end > c.start)
  }, [state.cuts])

  // Clear visual highlight when transcriptSelection is cleared externally (e.g. Backspace handler)
  useEffect(() => {
    if (!state.transcriptSelection && selStart >= 0) {
      setSelStart(-1)
      setSelEnd(-1)
    }
  }, [state.transcriptSelection])

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
        const selectedItems = displayItems.slice(minIdx, maxIdx + 1).map(d => ({ start: d.start, end: d.end }))
        dispatch({
          type: 'SET_TRANSCRIPT_SELECTION',
          payload: { startTime: displayItems[minIdx].start, endTime: displayItems[maxIdx].end, words: selectedItems },
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

  // Cmd+C / Ctrl+C — copy selected words to clipboard
  useEffect(() => {
    if (!hasSelection) return
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyC') {
        const text = displayItems.slice(selMin, selMax + 1)
          .map(d => d.word)
          .join(' ')
        navigator.clipboard.writeText(text)
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [hasSelection, selMin, selMax, displayItems])

  // Toggle word exclusion from annotation cuts on right-click
  const handleContextMenu = useCallback((idx, e) => {
    e.preventDefault()
    const item = displayItems[idx]
    if (item.type !== 'word') return
    const wordEnd = Math.max(item.end, item.start + 0.01)
    console.log(`[roughcut] Right-click exclude: "${item.word}" ${item.start.toFixed(2)}-${wordEnd.toFixed(2)}`)
    dispatch({ type: 'EXCLUDE_FROM_CUT', payload: { wordStart: item.start, wordEnd } })
  }, [displayItems, dispatch])

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
              {state.cutExclusions?.length > 0 && (
                <>
                  <div className="border-t border-white/10 my-1" />
                  <button
                    onClick={() => dispatch({ type: 'CLEAR_EXCLUSIONS' })}
                    className="flex items-center gap-3 w-full px-4 py-2 text-[11px] text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    Reset exclusions ({state.cutExclusions.length})
                  </button>
                </>
              )}
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

            // Check if this word is an unsafe filler (no silence gap — yellow highlight, not cut)
            const isUnsafeFiller = hasAnn && anns.some(a => unsafeFillerIds.has(a.id))

            // Determine background color
            let bgColor = undefined
            if (selected) {
              bgColor = 'rgba(206, 252, 0, 0.3)'
            } else if (isUnsafeFiller && !isGap) {
              bgColor = 'rgba(250, 204, 21, 0.25)' // yellow for unsafe fillers
            } else if (annColors && !isGap) {
              bgColor = annColors.bg
            }

            return (
              <span
                key={`${item.start}-${idx}`}
                ref={el => itemRefs.current[idx] = el}
                className={`cursor-text px-[1px] py-[2px] inline ${
                  cut && !isUnsafeFiller ? 'line-through text-on-surface-variant' : ''
                } ${
                  cut && !isUnsafeFiller && !selected && !isGap ? (hasAnn ? 'opacity-50' : 'opacity-30') : ''
                } ${
                  isCurrent && !cut && !bgColor ? 'bg-white/15' : ''
                } ${
                  isGap && !cut ? 'text-on-surface-variant/40 text-[11px]' : ''
                } ${
                  isGap && cut ? 'text-[11px] opacity-50' : ''
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
