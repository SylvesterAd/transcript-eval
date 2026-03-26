import { useState, useRef, useCallback, useEffect, useMemo, useContext } from 'react'
import { EditorContext } from './EditorView.jsx'

export default function TranscriptEditor() {
  const { state, dispatch, playbackEngine } = useContext(EditorContext)

  // Primary transcript: use the longest audio track's words as the single source.
  // Only fill in time gaps (ranges the primary doesn't cover) from other tracks.
  // This avoids merging different tokenizations of the same speech ("ChatGPT" vs "Chat GPT").
  const mergedWords = useMemo(() => {
    const audioTracks = state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .map(t => ({
        track: t,
        timelineStart: t.offset,
        timelineEnd: t.offset + t.duration,
      }))
      .sort((a, b) => (b.timelineEnd - b.timelineStart) - (a.timelineEnd - a.timelineStart)) // longest first

    if (!audioTracks.length) return []

    // Start with the longest track's words
    const primary = audioTracks[0]
    const words = primary.track.transcriptWords.map(w => ({
      word: w.word,
      start: w.start + primary.track.offset,
      end: w.end + primary.track.offset,
      trackId: primary.track.id,
    }))

    // Primary covers this timeline range (based on track offset+duration, not word boundaries)
    const coveredStart = primary.timelineStart
    const coveredEnd = primary.timelineEnd

    // Fill gaps from other tracks — only add words that START outside the primary's range
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

  // Selection state
  const [selStart, setSelStart] = useState(-1)
  const [selEnd, setSelEnd] = useState(-1)
  const [isSelecting, setIsSelecting] = useState(false)
  const containerRef = useRef(null)
  const wordRefs = useRef([])

  // Check if a word overlaps any cut region
  const isWordCut = useCallback((word) => {
    return state.cuts.some(c => word.start < c.end && word.end > c.start)
  }, [state.cuts])

  // Current word index during playback
  const currentWordIdx = useMemo(() => {
    if (!state.isPlaying) return -1
    return mergedWords.findIndex(w => state.currentTime >= w.start && state.currentTime < w.end)
  }, [mergedWords, state.currentTime, state.isPlaying])

  // Auto-scroll to current word during playback
  useEffect(() => {
    if (currentWordIdx < 0 || !containerRef.current) return
    const el = wordRefs.current[currentWordIdx]
    if (!el) return
    const container = containerRef.current
    const rect = el.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    if (rect.top < containerRect.top + 20 || rect.bottom > containerRect.bottom - 20) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [currentWordIdx])

  // Mouse handlers for word selection
  const handleMouseDown = useCallback((idx, e) => {
    e.preventDefault()
    setSelStart(idx)
    setSelEnd(idx)
    setIsSelecting(true)
  }, [])

  const handleMouseEnter = useCallback((idx) => {
    if (isSelecting) setSelEnd(idx)
  }, [isSelecting])

  useEffect(() => {
    if (!isSelecting) return
    const onUp = () => setIsSelecting(false)
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [isSelecting])

  const selMin = Math.min(selStart, selEnd)
  const selMax = Math.max(selStart, selEnd)
  const hasSelection = selStart >= 0 && selEnd >= 0

  // Click to seek (single click without drag)
  const handleClick = useCallback((idx) => {
    if (selStart === selEnd && selStart === idx) {
      const word = mergedWords[idx]
      dispatch({ type: 'SET_CURRENT_TIME', payload: word.start })
      playbackEngine.current?.seek(word.start)
    }
  }, [selStart, selEnd, mergedWords, dispatch, playbackEngine])

  // Remove cut on click (if word is cut, right-click to remove)
  const handleContextMenu = useCallback((idx, e) => {
    e.preventDefault()
    const word = mergedWords[idx]
    const cut = state.cuts.find(c => word.start < c.end && word.end > c.start)
    if (cut) {
      dispatch({ type: 'REMOVE_CUT', payload: cut.id })
    }
  }, [mergedWords, state.cuts, dispatch])

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
            {selMax - selMin + 1} words selected — press Backspace to cut
          </span>
        )}
        {state.cuts.length > 0 && (
          <span className="text-[10px] text-on-surface-variant/60">
            {state.cuts.length} cut{state.cuts.length !== 1 ? 's' : ''} — right-click cut text to remove
          </span>
        )}
      </div>

      {/* Word flow */}
      <div ref={containerRef} className="flex-1 overflow-auto px-5 py-4 select-none">
        <div className="leading-[2.2] text-[13px] text-on-surface">
          {mergedWords.map((word, idx) => {
            const cut = isWordCut(word)
            const selected = hasSelection && idx >= selMin && idx <= selMax
            const isCurrent = idx === currentWordIdx

            return (
              <span
                key={`${word.start}-${idx}`}
                ref={el => wordRefs.current[idx] = el}
                className={`cursor-pointer px-[3px] py-[2px] rounded transition-colors inline ${
                  cut ? 'line-through opacity-30 text-on-surface-variant' : ''
                } ${
                  selected && !cut ? 'bg-[#cefc00]/25' : ''
                } ${
                  isCurrent && !cut ? 'bg-white/15 rounded' : ''
                } hover:bg-white/10`}
                onMouseDown={(e) => handleMouseDown(idx, e)}
                onMouseEnter={() => handleMouseEnter(idx)}
                onClick={() => handleClick(idx)}
                onContextMenu={(e) => handleContextMenu(idx, e)}
              >
                {word.word}{' '}
              </span>
            )
          })}
          {mergedWords.length === 0 && (
            <div className="text-on-surface-variant/40 text-sm italic mt-8 text-center">
              No transcript available yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
