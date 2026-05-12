import { useContext, useRef, useCallback, useEffect, useLayoutEffect, useState, useMemo } from 'react'
import { EditorContext } from './EditorView.jsx'
import { formatTime, formatTimeRuler } from './useEditorState.js'
import { VideoTrack, AudioTrack, CompositeAudioTrack } from './TimelineTrack.jsx'
import VideoFrameTrack, { CompositeFrameTrack } from './VideoFrameTrack.jsx'
import BRollTrack, { BROLL_TRACK_H } from './BRollTrack.jsx'
import { BRollContext } from './useBRollEditorState.js'
import CutBar from './CutBar.jsx'
import { computeSkipRegions } from './usePlaybackSkipRegions.js'
import { postCutTime, unshiftPostCutTime } from '../../lib/timeTranslation.js'
import { getTrackPostCutLayout } from '../../lib/postCutTimeline.js'

const COMPOSITE_H = 80
const COMPOSITE_AUDIO_H = 56

export default function Timeline({ variants, activeVariantIdx, onVariantActivate, inactiveVariantPlacements, onCrossDrop, onCrossPaste }) {
  const { state, dispatch, totalDuration, playbackEngine, playheadRef, expandedCutAnchor, setExpandedCutAnchor, cutDragRef, selectedSegmentKey } = useContext(EditorContext)
  const isBroll = state.activeTab === 'brolls'

  // Drag the START of the cut following a selected segment (b-roll editor's
  // segment-edge drag). Direct UPDATE_CUT during drag; clamped to [0, cutEnd]
  // so the live state always has a valid cut. On release, three cases:
  //   - dragged past cutEnd → REMOVE_CUT + ADD_EXCLUSION (lock against AI regen)
  //   - finalStart > original (cut shrunk) → ADD_EXCLUSION over (original, final)
  //   - finalStart < original (cut grew leftward) → no extra dispatch
  //     (manuallyEdited:true on the UPDATE_CUT already prevents AI regen)
  const handleFollowingCutDrag = useCallback((cut, e) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startStart = cut.start
    const cutEnd = cut.end
    const cutId = cut.id
    if (cutDragRef) cutDragRef.current = true
    const onMove = (ev) => {
      const dx = ev.clientX - startX
      const newStart = Math.max(0, Math.min(cutEnd, startStart + dx / state.zoom))
      dispatch({ type: 'UPDATE_CUT', payload: { id: cutId, updates: { start: newStart } } })
    }
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (cutDragRef) cutDragRef.current = false
      const finalDx = ev.clientX - startX
      const finalStart = Math.max(0, startStart + finalDx / state.zoom)
      if (finalStart >= cutEnd - 0.05) {
        dispatch({ type: 'REMOVE_CUT', payload: cutId })
        dispatch({ type: 'ADD_EXCLUSION', payload: { start: startStart, end: cutEnd } })
      } else if (finalStart > startStart + 0.05) {
        dispatch({ type: 'ADD_EXCLUSION', payload: { start: startStart, end: finalStart } })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [state.zoom, dispatch, cutDragRef])
  const scrollRef = useRef(null)
  const rulerRef = useRef(null)
  const [scrollX, setScrollX] = useState(0)
  const [viewW, setViewW] = useState(1200)
  const prevZoomRef = useRef(state.zoom)
  const zoomAnchorRef = useRef(null) // { time, screenX } — set by wheel, null for +/- buttons

  // Stable empty-cuts reference for the falsy branch of track `cuts` props
  const EMPTY_CUTS = useMemo(() => [], [])

  // Cuts visible in the rough-cut tab UI: only user-applied cuts. Annotation-
  // source cuts stay in state.cuts so the b-roll pipeline + export still see
  // them, but they shouldn't render as cut regions in the rough-cut timeline —
  // mirrors TranscriptEditor.isItemCut. The user treats them as visual
  // suggestions until they explicitly Backspace to apply.
  const userCuts = useMemo(
    () => state.cuts.filter(c => c.source !== 'annotation'),
    [state.cuts]
  )

  // Merge cuts for display and refine edges using waveform
  const mergedDisplayCuts = useMemo(() => {
    if (!userCuts.length) return []

    // Build word list and waveform helpers
    const primaryAudio = state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .sort((a, b) => b.duration - a.duration)[0]
    const words = primaryAudio?.transcriptWords?.map(w => ({
      start: w.start + (primaryAudio.offset || 0),
      end: w.end + (primaryAudio.offset || 0),
    })) || []
    // Separate zero-width cuts (razor markers) from real cuts
    const zeroWidth = userCuts.filter(c => c.end <= c.start + 0.01 && c.end >= c.start)
    const valid = userCuts.filter(c => c.end > c.start + 0.01)
    if (!valid.length) return [...zeroWidth]
    const sorted = [...valid].sort((a, b) => a.start - b.start)
    const merged = [{ ...sorted[0] }]
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1]
      if (sorted[i].start <= last.end + 0.05) {
        last.end = Math.max(last.end, sorted[i].end)
      } else {
        const hasWord = words.some(w => w.start >= last.end - 0.05 && w.end <= sorted[i].start + 0.05)
        if (!hasWord) {
          last.end = Math.max(last.end, sorted[i].end)
        } else {
          merged.push({ ...sorted[i] })
        }
      }
    }

    return [...merged, ...zeroWidth]
  }, [userCuts, state.tracks])

  // B-roll editor: cuts collapse to thin purple bars. Clicking a bar expands
  // that one cut as a popover overlay (rough-cut style dark gap + draggable
  // edges + transcript) sitting on top of the post-cut timeline. The layout
  // is stable: the popover OVERLAPS content to its right rather than pushing
  // it. This keeps the ruler labels and b-roll positions fixed when the user
  // drills in to inspect a cut.
  //
  // - effectiveCuts: cuts minus exclusions (every join in original-time);
  //   drives layout (postCutDuration, postCutTime calls, ruler, playhead,
  //   track outer size, transcript/frame/waveform filters, BRollTrack
  //   placements). Includes the expanded cut — the popover sits on top.
  // - expandedCut:   the cut currently rendered as a popover (or null),
  //   resolved by anchor-contains lookup.
  const effectiveCuts = useMemo(() => {
    if (!isBroll) return []
    // Word-aware merge keeps two cuts that span a non-transcribed gap from
    // leaving a sliver visible in the b-roll layout — mirrors EditorView.
    const primaryAudio = state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .sort((a, b) => b.duration - a.duration)[0]
    const words = primaryAudio?.transcriptWords?.map(w => ({
      start: w.start + (primaryAudio.offset || 0),
      end: w.end + (primaryAudio.offset || 0),
    })) || null
    return computeSkipRegions(userCuts, state.cutExclusions, words)
  }, [isBroll, userCuts, state.cutExclusions, state.tracks])
  // expandedCutAnchor is an original-time timestamp (typically the cut's
  // center at click). Resolve to the effective cut whose interval contains
  // it. Anchor identity survives edge-resize drags that change cut bounds
  // mid-drag, which a `${start}-${end}` key would not.
  const expandedCut = useMemo(() => {
    if (expandedCutAnchor == null) return null
    return effectiveCuts.find(c => c.start - 0.01 <= expandedCutAnchor && expandedCutAnchor <= c.end + 0.01) || null
  }, [effectiveCuts, expandedCutAnchor])

  const primaryAudioWords = useMemo(() => {
    if (!isBroll) return []
    const primaryAudio = state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .sort((a, b) => b.duration - a.duration)[0]
    if (!primaryAudio?.transcriptWords) return []
    const off = primaryAudio.offset || 0
    return primaryAudio.transcriptWords.map(w => ({
      word: w.word,
      start: w.start + off,
      end: w.end + off,
    }))
  }, [isBroll, state.tracks])

  // Total cut duration → post-cut duration. Drives contentWidth,
  // playhead translation, and ruler positions in b-roll mode.
  const postCutDuration = useMemo(() => {
    if (!isBroll) return totalDuration
    const total = effectiveCuts.reduce((s, c) => s + (c.end - c.start), 0)
    return Math.max(0.001, totalDuration - total)
  }, [isBroll, effectiveCuts, totalDuration])

  // Translate original-time → on-screen x in b-roll mode (cuts collapse).
  // Rough-cut mode is a passthrough (postCutTime returns input when
  // effectiveCuts is empty).
  const tToX = useCallback((t) => (
    isBroll ? postCutTime(t, effectiveCuts) * state.zoom : t * state.zoom
  ), [isBroll, effectiveCuts, state.zoom])

  // Track horizontal scroll for virtualized tick rendering
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => setScrollX(el.scrollLeft))
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll); cancelAnimationFrame(raf) }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setViewW(el.clientWidth || 1200)
    })
    ro.observe(el)
    setViewW(el.clientWidth || 1200)
    return () => ro.disconnect()
  }, [])

  // contentWidth uses totalDuration in both modes. In b-roll mode the a-roll
  // tracks collapse to postCutDuration, but b-rolls render at original-time
  // positions (timelineStart * zoom — no postCutTime translation) so the
  // scroll content must extend to totalDuration*zoom to accommodate them.
  const contentWidth = Math.max(totalDuration * state.zoom, 800)

  // Adaptive 3-tier interval selection: major (labeled) → minor → sub-minor
  const INTERVALS = [
    { major: 0.01,  minor: 0.005, sub: 0.001 },
    { major: 0.05,  minor: 0.01,  sub: 0.005 },
    { major: 0.1,   minor: 0.05,  sub: 0.01  },
    { major: 0.2,   minor: 0.05,  sub: 0.01  },
    { major: 0.5,   minor: 0.1,   sub: 0.05  },
    { major: 1,     minor: 0.5,   sub: 0.1   },
    { major: 2,     minor: 1,     sub: 0.5   },
    { major: 5,     minor: 1,     sub: 0.5   },
    { major: 10,    minor: 5,     sub: 1     },
    { major: 30,    minor: 10,    sub: 5     },
    { major: 60,    minor: 30,    sub: 10    },
    { major: 120,   minor: 60,    sub: 30    },
    { major: 300,   minor: 60,    sub: 30    },
  ]

  const { iv, minorPx, subPx, majorMarks } = useMemo(() => {
    let iv = INTERVALS[INTERVALS.length - 1]
    for (const entry of INTERVALS) {
      if (entry.major * state.zoom >= 80) { iv = entry; break }
    }
    const minorPx = iv.minor * state.zoom
    const subPx = iv.sub * state.zoom
    const rulerDuration = isBroll ? postCutDuration : totalDuration
    const visStartTime = Math.max(0, (scrollX - 300) / state.zoom)
    const visEndTime = (scrollX + viewW + 300) / state.zoom
    const firstMajor = Math.floor(visStartTime / iv.major) * iv.major
    const lastMajor = Math.ceil(visEndTime / iv.major) * iv.major
    const marks = []
    // In b-roll: ticks/labels denote post-cut seconds, positioned at t * zoom.
    // In rough cut: original-time, same formula.
    for (let t = firstMajor; t <= Math.min(lastMajor, rulerDuration + iv.major); t += iv.major) {
      const time = Math.round(t * 1000) / 1000
      marks.push({ time, label: formatTimeRuler(time, iv.major), x: time * state.zoom })
    }
    return { iv, minorPx, subPx, majorMarks: marks }
  }, [state.zoom, scrollX, totalDuration, postCutDuration, isBroll, viewW])

  // Scrub on ruler click. In b-roll the ruler is in post-cut space, so the
  // pixel-to-time conversion produces a post-cut second; un-shift back to
  // original-time before dispatching (state.currentTime stays original-time).
  const handleRulerClick = useCallback((e) => {
    const rect = rulerRef.current?.getBoundingClientRect()
    if (!rect) return
    // getBoundingClientRect already accounts for scroll — no scrollLeft needed.
    const x = e.clientX - rect.left
    const tDisplay = Math.max(0, x / state.zoom)
    const time = isBroll ? unshiftPostCutTime(tDisplay, effectiveCuts, 'start') : tDisplay
    dispatch({ type: 'SET_CURRENT_TIME', payload: time })
    playbackEngine.current?.seek(time)
  }, [state.zoom, isBroll, effectiveCuts, dispatch, playbackEngine])

  // Zoom with Ctrl+wheel — non-passive listener to block browser page zoom
  const zoomRef = useRef(state.zoom)
  zoomRef.current = state.zoom
  useEffect(() => {
    const container = scrollRef.current?.parentElement
    if (!container) return
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const el = scrollRef.current
      if (!el) return
      const zoom = zoomRef.current
      const step = Math.max(1, Math.round(zoom * 0.05)) // 5% of current zoom
      const delta = e.deltaY > 0 ? -step : step
      const newZoom = Math.max(5, Math.min(1000, zoom + delta))
      if (newZoom === zoom) return
      const labelW = 144
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left
      const timeAtCursor = (el.scrollLeft + cursorX - labelW) / zoom
      // Store anchor — useEffect will adjust scroll after React re-renders
      zoomAnchorRef.current = { time: timeAtCursor, screenX: cursorX }
      dispatch({ type: 'SET_ZOOM', payload: newZoom })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => container.removeEventListener('wheel', onWheel)
  }, [dispatch])

  // Adjust scroll after zoom change — useLayoutEffect runs synchronously after DOM update,
  // before paint, so content width is already correct and scrollLeft won't get clamped.
  useLayoutEffect(() => {
    const oldZoom = prevZoomRef.current
    if (oldZoom === state.zoom) return
    prevZoomRef.current = state.zoom
    const el = scrollRef.current
    if (!el) return
    const labelW = 144
    const anchor = zoomAnchorRef.current
    if (anchor) {
      // Wheel zoom: keep cursor point stable
      el.scrollLeft = anchor.time * state.zoom - anchor.screenX + labelW
      zoomAnchorRef.current = null
    } else if (!isBroll) {
      // +/- buttons (rough cut only): keep playhead at the CENTER of viewport.
      // B-roll editor leaves scrollLeft alone — user explicitly does not want recentering.
      const viewW = el.clientWidth
      el.scrollLeft = state.currentTime * state.zoom - viewW / 2 + labelW
    } /* b-roll: scroll preserved across zoom (matches existing UX). */
  }, [state.zoom])

  // Own the playhead transform for render-driven updates (mount, zoom change, paused seek).
  // During playback the rAF engine in EditorView writes transform directly at 60fps — this
  // effect must NOT fire then, or it would overwrite the live value with a 10Hz-stale one
  // (the same class of bug this task was created to fix).
  // In b-roll mode currentTime stays original-time; render translates through postCutTime.
  useLayoutEffect(() => {
    if (!playheadRef.current) return
    if (state.isPlaying) return
    const x = isBroll
      ? postCutTime(state.currentTime, effectiveCuts) * state.zoom
      : state.currentTime * state.zoom
    playheadRef.current.style.transform = `translateX(${x}px)`
  }, [state.zoom, state.currentTime, state.isPlaying, isBroll, effectiveCuts, playheadRef])

  // Auto-scroll during playback — smooth follow, playhead stays at ~1/5 from left
  const currentTimeRef = useRef(state.currentTime)
  currentTimeRef.current = state.currentTime
  useEffect(() => {
    if (isBroll) return
    if (!state.isPlaying || !scrollRef.current) return
    let raf
    let following = false
    const tick = () => {
      const el = scrollRef.current
      const ph = playheadRef.current
      if (!el || !ph) { raf = requestAnimationFrame(tick); return }
      // Read playhead pixel position directly from DOM (updated at 60fps by playback engine)
      const match = ph.style.transform.match(/translateX\(([^)]+)px\)/)
      const playheadX = match ? parseFloat(match[1]) : currentTimeRef.current * zoomRef.current
      const { scrollLeft, clientWidth } = el
      const screenPos = playheadX - scrollLeft

      if (!following && screenPos > clientWidth * 0.8) {
        following = true
      }
      if (following) {
        el.scrollLeft = playheadX - clientWidth * 0.8
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isBroll, state.isPlaying])

  // Scroll timeline into view on seek (word click, etc.) when not playing.
  // Disabled in b-roll editor — user wants the viewport to stay where they put it.
  useEffect(() => {
    if (isBroll) return
    if (state.isPlaying || !scrollRef.current) return
    const el = scrollRef.current
    const playheadX = state.currentTime * state.zoom
    const { scrollLeft, clientWidth } = el
    if (playheadX < scrollLeft + 100 || playheadX > scrollLeft + clientWidth - 100) {
      el.scrollLeft = playheadX - clientWidth / 3
    }
  }, [isBroll, state.isPlaying, state.currentTime, state.zoom])

  // Stable numbering: based on original load order, never changes on reorder
  const trackNumber = useCallback((track) => {
    const order = state.originalVideoOrder || []
    const videoId = track.type === 'video' ? track.id : `v-${track.videoId}`
    const idx = order.indexOf(videoId)
    return idx >= 0 ? idx + 1 : 1
  }, [state.originalVideoOrder])

  // Visible tracks (respects audioOnly) with layout for mixed-height drag
  const isRoughCut = state.activeTab === 'roughcut'
  const showVideoFrames = isRoughCut || state.activeTab === 'brolls'
  const isMainMode = isRoughCut && state.roughCutTrackMode === 'main'

  // In MAIN mode, compute merged segments from video tracks.
  // Overlapping tracks are merged into one segment — the earliest track is the default camera,
  // and the segment extends to the max end of all overlapping tracks.
  const mainTrackSegments = useMemo(() => {
    if (!isMainMode) return null
    const videoTracks = state.tracks
      .filter(t => t.type === 'video')
      .sort((a, b) => a.offset - b.offset)
    if (!videoTracks.length) return []
    const segments = []
    let cur = null
    for (const track of videoTracks) {
      const trackEnd = track.offset + track.duration
      if (cur && track.offset < cur.end) {
        // Overlapping — extend segment end
        cur.end = Math.max(cur.end, trackEnd)
      } else {
        // New segment — first track is the default camera
        cur = { start: track.offset, end: trackEnd, videoId: track.videoId, trackId: track.id, title: track.title, offset: track.offset, duration: track.duration, filePath: track.filePath, groupId: track.groupId }
        segments.push(cur)
      }
    }
    return segments
  }, [isMainMode, state.tracks])

  // Available cameras per segment (stable, only recomputes on track changes)
  const segmentCameras = useMemo(() => {
    if (!mainTrackSegments?.length) return []
    return mainTrackSegments.map(seg => {
      return state.tracks
        .filter(t => t.type === 'video' && t.offset < seg.end && t.offset + t.duration > seg.start)
        .map(t => ({ videoId: t.videoId, trackId: t.id, number: trackNumber(t) }))
    })
  }, [mainTrackSegments, state.tracks, trackNumber])

  // Which segment contains the playhead (search backwards for robustness at boundaries)
  const currentSegmentIndex = useMemo(() => {
    if (!mainTrackSegments?.length) return 0
    for (let i = mainTrackSegments.length - 1; i >= 0; i--) {
      if (state.currentTime >= mainTrackSegments[i].start) return i
    }
    return 0
  }, [mainTrackSegments, state.currentTime])

  // Effective video segments with overrides applied
  const effectiveVideoSegments = useMemo(() => {
    if (!mainTrackSegments?.length) return mainTrackSegments
    return mainTrackSegments.map((seg, i) => {
      const ov = state.segmentVideoOverrides[i]
      if (!ov || ov === seg.videoId) return seg
      const t = state.tracks.find(t => t.type === 'video' && t.videoId === ov)
      if (!t || t.offset >= seg.end || t.offset + t.duration <= seg.start) return seg
      return { ...seg, videoId: ov, trackId: t.id, title: t.title, filePath: t.filePath, groupId: t.groupId, offset: t.offset, duration: t.duration }
    })
  }, [mainTrackSegments, state.segmentVideoOverrides, state.tracks])

  // Effective audio segments with overrides applied
  const effectiveAudioSegments = useMemo(() => {
    if (!mainTrackSegments?.length) return mainTrackSegments
    return mainTrackSegments.map((seg, i) => {
      const ov = state.segmentAudioOverrides[i]
      if (!ov || ov === seg.videoId) return seg
      const t = state.tracks.find(t => t.type === 'video' && t.videoId === ov)
      if (!t || t.offset >= seg.end || t.offset + t.duration <= seg.start) return seg
      return { ...seg, videoId: ov, trackId: t.id, title: t.title, filePath: t.filePath, groupId: t.groupId, offset: t.offset, duration: t.duration }
    })
  }, [mainTrackSegments, state.segmentAudioOverrides, state.tracks])

  // Active video/audio IDs for the current segment (with override + fallback)
  const activeVideoId = useMemo(() => {
    const seg = mainTrackSegments?.[currentSegmentIndex]
    if (!seg) return null
    const ov = state.segmentVideoOverrides[currentSegmentIndex]
    if (ov) {
      const t = state.tracks.find(t => t.type === 'video' && t.videoId === ov)
      if (t && state.currentTime >= t.offset && state.currentTime < t.offset + t.duration) return ov
    }
    return seg.videoId
  }, [mainTrackSegments, currentSegmentIndex, state.segmentVideoOverrides, state.tracks, state.currentTime])

  const activeAudioId = useMemo(() => {
    const seg = mainTrackSegments?.[currentSegmentIndex]
    if (!seg) return null
    const ov = state.segmentAudioOverrides[currentSegmentIndex]
    if (ov) {
      const t = state.tracks.find(t => t.type === 'video' && t.videoId === ov)
      if (t && state.currentTime >= t.offset && state.currentTime < t.offset + t.duration) return ov
    }
    return seg.videoId
  }, [mainTrackSegments, currentSegmentIndex, state.segmentAudioOverrides, state.tracks, state.currentTime])

  const currentCameras = segmentCameras[currentSegmentIndex] || []

  // Resolve B-Roll track position: -1 means "after last audio track"
  const broll = useContext(BRollContext)
  const hasBrollTrack = !!broll?.placements?.length || (inactiveVariantPlacements && Object.values(inactiveVariantPlacements).some(p => p?.length > 0))
  const brollVariantCount = variants?.length > 1 ? variants.length : 1
  const resolvedBrollPosition = useMemo(() => {
    if (!hasBrollTrack) return -2 // no B-Roll track to show
    const pos = state.brollTrackPosition
    if (pos >= 0 && pos <= state.tracks.length) return pos
    // Default: after last audio track
    let lastAudioIdx = -1
    for (let i = 0; i < state.tracks.length; i++) {
      if (state.tracks[i].type === 'audio') lastAudioIdx = i
    }
    return lastAudioIdx + 1
  }, [state.brollTrackPosition, state.tracks, hasBrollTrack])

  const visibleLayout = useMemo(() => {
    const items = []
    const compositeAudioH = state.compositeShowTranscript ? 48 : 24
    let y = isMainMode ? COMPOSITE_H + compositeAudioH : 0
    let trackSlot = 0 // counts visible track slots for B-Roll insertion
    let brollInserted = false
    // Track which indices have been consumed by a pair so they aren't rendered
    // a second time as a solo row. Pairs match V+A by videoId regardless of
    // their order or how many tracks (or b-roll inserts) sit between them.
    const consumedIdx = new Set()
    let i = 0
    while (i < state.tracks.length) {
      if (consumedIdx.has(i)) { i++; continue }
      const t = state.tracks[i]
      if (t.type === 'video' && ((!isRoughCut && state.audioOnly) || isMainMode)) { i++; continue }
      if (t.type === 'audio' && isMainMode) { i++; continue }
      // Insert B-Roll rows before this track if position matches
      if (!brollInserted && hasBrollTrack && resolvedBrollPosition <= i) {
        for (let vi = 0; vi < brollVariantCount; vi++) {
          items.push({ absIdx: -1 - vi, y, h: BROLL_TRACK_H, isBroll: true, variantIdx: vi })
          y += BROLL_TRACK_H
        }
        brollInserted = true
      }
      // Pair detection: V + A for the same videoId, regardless of order or
      // distance in state.tracks. The pair renders at the FIRST track's
      // position. The first track in state.tracks order goes on TOP of the
      // combined block (so a [A, V] state shows A on top, V on bottom — and
      // vice versa). This makes V+A read as one combined CapCut-style clip
      // block while still respecting the user's track ordering.
      if (!isMainMode && (t.type === 'video' || t.type === 'audio')) {
        const matchType = t.type === 'video' ? 'audio' : 'video'
        const matchIdx = state.tracks.findIndex((mt, mi) => (
          mi !== i && !consumedIdx.has(mi) && mt.type === matchType && mt.videoId === t.videoId
        ))
        if (matchIdx >= 0) {
          const videoIdx = t.type === 'video' ? i : matchIdx
          const audioIdx = t.type === 'audio' ? i : matchIdx
          const audioTrack = state.tracks[audioIdx]
          const vH = showVideoFrames ? 40 : 24
          const aH = audioTrack.showTranscript ? 48 : 24
          const h = vH + aH
          // Render order follows state.tracks order (smaller index = on top).
          const topIsVideo = videoIdx < audioIdx
          items.push({ absIdx: i, videoAbsIdx: videoIdx, audioAbsIdx: audioIdx, y, h, isPair: true, vH, aH, topIsVideo })
          y += h
          trackSlot++
          consumedIdx.add(videoIdx)
          consumedIdx.add(audioIdx)
          i++
          continue
        }
      }
      const h = t.type === 'video' ? (showVideoFrames ? 40 : 24) : (t.showTranscript ? 48 : 24)
      items.push({ absIdx: i, y, h })
      y += h
      trackSlot++
      i++
    }
    // B-Roll at the end if not yet inserted
    if (!brollInserted && hasBrollTrack) {
      for (let vi = 0; vi < brollVariantCount; vi++) {
        items.push({ absIdx: -1 - vi, y, h: BROLL_TRACK_H, isBroll: true, variantIdx: vi })
        y += BROLL_TRACK_H
      }
    }
    return items
  }, [state.tracks, state.audioOnly, isRoughCut, showVideoFrames, isMainMode, state.compositeShowTranscript, hasBrollTrack, resolvedBrollPosition, brollVariantCount])

  // Context menu
  const ctxTrack = state.contextMenu ? state.tracks.find(t => t.id === state.contextMenu.trackId) : null

  // Unified track drag reorder — any track can be moved to any position
  const [dragState, setDragState] = useState({ dragging: false, fromAbsIdx: -2, overAbsIdx: -2, dy: 0 })
  const dragDidMove = useRef(false)
  const mouseYRef = useRef(0)
  const scrollRafRef = useRef(0)

  // Auto-scroll when dragging near edges of scroll container
  const startAutoScroll = useCallback(() => {
    const tick = () => {
      const el = scrollRef.current
      if (!el) { scrollRafRef.current = requestAnimationFrame(tick); return }
      const rect = el.getBoundingClientRect()
      const y = mouseYRef.current
      const edge = 60
      if (y > rect.top && y < rect.top + edge) {
        el.scrollTop -= Math.max(2, (edge - (y - rect.top)) * 0.3)
      } else if (y < rect.bottom && y > rect.bottom - edge) {
        el.scrollTop += Math.max(2, (edge - (rect.bottom - y)) * 0.3)
      }
      scrollRafRef.current = requestAnimationFrame(tick)
    }
    scrollRafRef.current = requestAnimationFrame(tick)
  }, [])

  const stopAutoScroll = useCallback(() => {
    cancelAnimationFrame(scrollRafRef.current)
  }, [])

  const handleTrackDragStart = useCallback((e, absIdx) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startY = e.clientY
    const startScrollTop = scrollRef.current?.scrollTop || 0
    dragDidMove.current = false
    mouseYRef.current = e.clientY

    const layout = visibleLayout
    const visIdx = layout.findIndex(l => l.absIdx === absIdx)
    if (visIdx === -1) return
    const startTrackY = layout[visIdx].y
    const trackH = layout[visIdx].h
    let dropAbsIdx = absIdx

    const onMove = (ev) => {
      mouseYRef.current = ev.clientY
      const scrollDelta = (scrollRef.current?.scrollTop || 0) - startScrollTop
      const dy = ev.clientY - startY
      const logicalDy = dy + scrollDelta
      if (!dragDidMove.current && Math.abs(dy) < 5) return
      if (!dragDidMove.current) {
        dragDidMove.current = true
        setDragState({ dragging: true, fromAbsIdx: absIdx, overAbsIdx: absIdx, dy: 0 })
        startAutoScroll()
      }
      // Find target slot using cumulative heights
      const targetCenterY = startTrackY + trackH / 2 + logicalDy
      let dropVisIdx = visIdx
      for (let i = 0; i < layout.length; i++) {
        if (targetCenterY >= layout[i].y && targetCenterY < layout[i].y + layout[i].h) {
          dropVisIdx = i
          break
        }
      }
      if (targetCenterY < 0) dropVisIdx = 0
      if (targetCenterY >= layout[layout.length - 1].y + layout[layout.length - 1].h) dropVisIdx = layout.length - 1
      dropAbsIdx = layout[dropVisIdx].absIdx
      setDragState(prev => ({ ...prev, overAbsIdx: dropAbsIdx, dy }))
    }
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      stopAutoScroll()
      setDragState({ dragging: false, fromAbsIdx: -2, overAbsIdx: -2, dy: 0 })
      if (dragDidMove.current && absIdx !== dropAbsIdx) {
        if (absIdx === -1) {
          // Dragging B-Roll track: find the real track index at the drop position
          const dropItem = layout.find(l => l.absIdx === dropAbsIdx)
          const targetIdx = dropItem && !dropItem.isBroll ? dropAbsIdx : resolvedBrollPosition
          dispatch({ type: 'MOVE_BROLL_TRACK', payload: targetIdx })
        } else if (dropAbsIdx === -1) {
          // Dropping a regular track at the B-Roll row position — reorder to B-Roll's slot
          dispatch({ type: 'REORDER_TRACK', payload: { fromIndex: absIdx, toIndex: resolvedBrollPosition } })
        } else {
          dispatch({ type: 'REORDER_TRACK', payload: { fromIndex: absIdx, toIndex: dropAbsIdx } })
        }
      } else if (!dragDidMove.current && absIdx >= 0) {
        dispatch({
          type: 'SELECT_TRACK',
          payload: { trackId: state.tracks[absIdx]?.id, shift: ev.shiftKey, meta: ev.metaKey || ev.ctrlKey }
        })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [visibleLayout, state.tracks, dispatch, startAutoScroll, stopAutoScroll])

  // Stable per-variant onActivate factories for BRollTrack memoization
  const variantActivators = useMemo(() => {
    const out = []
    for (let vi = 0; vi < brollVariantCount; vi++) {
      out.push((selectIdentity) => onVariantActivate?.(vi, selectIdentity))
    }
    return out
  }, [brollVariantCount, onVariantActivate])

  return (
    <div
      className="h-full bg-surface-container-low rounded-xl flex flex-col overflow-hidden relative border border-white/5"
      onClick={() => state.contextMenu && dispatch({ type: 'CLOSE_CONTEXT_MENU' })}
    >
      {/* Single scroll container for everything */}
      <div ref={scrollRef} className="flex-1 overflow-auto editor-scroll relative bg-surface-dim">
        <div className="relative" style={{ minWidth: `${contentWidth + 128}px` }}>

          {/* Ruler row — sticky top */}
          <div className="sticky top-0 z-20 flex h-10 border-b border-white/5">
            {/* Corner */}
            <div className="sticky left-0 w-36 shrink-0 bg-surface-container z-30" />
            {/* Ruler */}
            <div
              ref={rulerRef}
              className="flex-1 relative bg-surface-container cursor-pointer overflow-hidden"
              onClick={handleRulerClick}
            >
              <div className="relative h-full" style={{ minWidth: `${contentWidth}px` }}>
                {/* Sub-minor ticks — CSS gradient, zero DOM elements */}
                {subPx >= 2 && (
                  <div className="absolute bottom-0 pointer-events-none" style={{
                    left: 0, right: 0, height: '4px',
                    backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.08) 0px, rgba(255,255,255,0.08) 1px, transparent 1px, transparent ${subPx}px)`,
                  }} />
                )}
                {/* Minor ticks — CSS gradient, zero DOM elements */}
                {minorPx >= 2 && (
                  <div className="absolute bottom-0 pointer-events-none" style={{
                    left: 0, right: 0, height: '8px',
                    backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.15) 0px, rgba(255,255,255,0.15) 1px, transparent 1px, transparent ${minorPx}px)`,
                  }} />
                )}
                {/* Major ticks + centered labels */}
                {majorMarks.map((m) => (
                  <div key={m.time} className="absolute bottom-0" style={{ left: `${m.x}px` }}>
                    <div className="absolute bottom-0 w-px bg-white/30" style={{ height: '14px' }} />
                    <span
                      className={`absolute bottom-3.5 text-[9px] font-mono whitespace-nowrap ${
                        Math.abs(m.time - state.currentTime) < iv.major * 0.5 ? 'text-primary-fixed font-bold opacity-100' : 'opacity-30'
                      }`}
                      style={{ transform: m.time === 0 ? 'none' : 'translateX(-50%)' }}
                    >
                      {m.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Composite video + audio tracks in MAIN mode */}
          {isMainMode && mainTrackSegments?.length > 0 && (
            <>
              <div className="relative">
                <div className="flex">
                  <div className="sticky left-0 w-36 shrink-0 border-b border-r border-white/10 flex items-center pl-2 pr-2 text-[10px] font-bold gap-1 z-30 bg-surface-container text-on-surface-variant" style={{ height: '80px' }}>
                    <span className="material-symbols-outlined text-[12px] shrink-0 opacity-30">drag_indicator</span>
                    <div className="grid grid-cols-2 gap-px flex-1 min-w-0">
                      {currentCameras.map(cam => {
                        const isActive = cam.videoId === activeVideoId
                        const t = state.tracks.find(t => t.type === 'video' && t.videoId === cam.videoId)
                        const trackCoversNow = t && state.currentTime >= t.offset && state.currentTime < t.offset + t.duration
                        return (
                          <button key={cam.videoId}
                            disabled={!trackCoversNow}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); dispatch({ type: 'SET_SEGMENT_VIDEO_OVERRIDE', payload: { segIndex: currentSegmentIndex, videoId: cam.videoId } }) }}
                            className={`text-[8px] font-bold rounded px-1 py-0.5 transition-colors ${!trackCoversNow ? 'cursor-not-allowed' : ''}`}
                            style={isActive
                              ? { color: '#cefc00', backgroundColor: 'rgba(206,252,0,0.15)' }
                              : trackCoversNow
                                ? { color: '#fff', opacity: 0.7 }
                                : { opacity: 0.2 }}
                          >
                            V{cam.number}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="flex-1 relative z-0">
                    <CompositeFrameTrack segments={effectiveVideoSegments} zoom={state.zoom} cuts={mergedDisplayCuts} scrollRef={scrollRef} scrollX={scrollX} />
                  </div>
                </div>
              </div>
              <div className="relative">
                <div className="flex">
                  <div className="sticky left-0 w-36 shrink-0 border-b border-r border-white/5 flex items-center pl-2 pr-2 text-[10px] font-bold gap-1 z-30 bg-surface-container text-on-surface-variant" style={{ height: state.compositeShowTranscript ? '112px' : '56px' }}>
                    <span className="material-symbols-outlined text-[12px] shrink-0 opacity-30">drag_indicator</span>
                    <div className="grid grid-cols-2 gap-px flex-1 min-w-0">
                      {currentCameras.map(cam => {
                        const isActive = cam.videoId === activeAudioId
                        const t = state.tracks.find(t => t.type === 'video' && t.videoId === cam.videoId)
                        const trackCoversNow = t && state.currentTime >= t.offset && state.currentTime < t.offset + t.duration
                        return (
                          <button key={cam.videoId}
                            disabled={!trackCoversNow}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); dispatch({ type: 'SET_SEGMENT_AUDIO_OVERRIDE', payload: { segIndex: currentSegmentIndex, videoId: cam.videoId } }) }}
                            className={`text-[8px] font-bold rounded px-1 py-0.5 transition-colors ${!trackCoversNow ? 'cursor-not-allowed' : ''}`}
                            style={isActive
                              ? { color: '#cefc00', backgroundColor: 'rgba(206,252,0,0.15)' }
                              : trackCoversNow
                                ? { color: '#fff', opacity: 0.7 }
                                : { opacity: 0.2 }}
                          >
                            A{cam.number}
                          </button>
                        )
                      })}
                    </div>
                    <div className="h-3 w-[1px] shrink-0 bg-white/30" />
                    <button
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => dispatch({ type: 'TOGGLE_COMPOSITE_TRANSCRIPT' })}
                      className="material-symbols-outlined text-[9px] shrink-0"
                      style={state.compositeShowTranscript ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                    >
                      text_fields
                    </button>
                  </div>
                  <div className="flex-1 relative z-0">
                    <CompositeAudioTrack segments={effectiveAudioSegments} zoom={state.zoom} cuts={mergedDisplayCuts} scrollRef={scrollRef} scrollX={scrollX} showTranscript={state.compositeShowTranscript} />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Track rows — unified list including B-Roll, any track can be dragged to any position */}
          {visibleLayout.map((item) => {
            const absIdx = item.absIdx
            const isDragSource = dragState.dragging && dragState.fromAbsIdx === absIdx
            const showInsertBefore = dragState.dragging && dragState.overAbsIdx === absIdx && dragState.fromAbsIdx > absIdx
            const showInsertAfter = dragState.dragging && dragState.overAbsIdx === absIdx && dragState.fromAbsIdx < absIdx

            // B-Roll track row (one per variant)
            if (item.isBroll) {
              const vi = item.variantIdx ?? 0
              const isActiveVariant = vi === (activeVariantIdx ?? 0)
              const variantLabel = variants?.[vi]?.label || 'B-Roll'
              return (
                <div key={`broll-track-${vi}`} data-broll-variant={vi} className="relative" style={isDragSource ? { opacity: 0.5, zIndex: 30, transform: `translateY(${dragState.dy}px)`, pointerEvents: 'none' } : undefined}>
                  {showInsertBefore && vi === 0 && <div className="absolute top-0 left-0 right-0 h-[3px] bg-primary-fixed z-20 shadow-[0_0_8px_rgba(206,252,0,0.7)] rounded-full" />}
                  <div className="flex">
                    <div
                      onMouseDown={isActiveVariant ? (e) => handleTrackDragStart(e, -1) : undefined}
                      className={`sticky left-0 w-36 shrink-0 border-b border-r border-white/5 flex items-center pl-2 text-[10px] font-bold z-30 bg-surface-container select-none ${
                        isActiveVariant ? 'text-primary-fixed cursor-grab active:cursor-grabbing' : 'text-zinc-500'
                      } ${isDragSource && isActiveVariant ? 'ring-1 ring-primary-fixed bg-primary-fixed/10' : ''}`}
                      style={{ height: `${BROLL_TRACK_H}px` }}
                    >
                      <span className={`material-symbols-outlined text-[12px] shrink-0 mr-1 ${isDragSource ? 'text-primary-fixed opacity-100' : 'opacity-30'}`}>drag_indicator</span>
                      <span className="truncate">{variantLabel}</span>
                      {variants?.length > 1 && (
                        <>
                          <div className="h-3 w-[1px] shrink-0 bg-white/10 mx-1" />
                          <button
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => { e.stopPropagation(); onVariantActivate?.(vi) }}
                            className="material-symbols-outlined text-[9px] shrink-0"
                            style={isActiveVariant ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                          >
                            {isActiveVariant ? 'visibility' : 'visibility_off'}
                          </button>
                        </>
                      )}
                    </div>
                    <div className={`flex-1 relative z-0 ${!isActiveVariant ? 'opacity-40' : ''}`}>
                      <BRollTrack
                        zoom={state.zoom}
                        viewW={viewW}
                        scrollX={scrollX}
                        postCutCuts={null}
                        isActive={isActiveVariant}
                        onActivate={variantActivators[vi]}
                        overridePlacements={!isActiveVariant ? inactiveVariantPlacements?.[variants?.[vi]?.id] : undefined}
                        variants={variants}
                        activeVariantIdx={activeVariantIdx}
                        localVariantIdx={vi}
                        onCrossDrop={onCrossDrop}
                        onCrossPaste={onCrossPaste}
                      />
                    </div>
                  </div>
                  {showInsertAfter && vi === brollVariantCount - 1 && <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-primary-fixed z-20 shadow-[0_0_8px_rgba(206,252,0,0.7)] rounded-full" />}
                </div>
              )
            }

            // Pair row: V+A for the same source rendered inside one flex-1
            // container so they read as a single CapCut-style clip block.
            // Stacking order respects state.tracks order — whichever index is
            // smaller goes on top (item.topIsVideo === true means V comes
            // first; false means A comes first and goes on top).
            if (item.isPair) {
              const videoTrack = state.tracks[item.videoAbsIdx]
              const audioTrack = state.tracks[item.audioAbsIdx]
              if (!videoTrack || !audioTrack) return null
              const vSelected = state.selectedTrackIds.has(videoTrack.id)
              const aSelected = state.selectedTrackIds.has(audioTrack.id)
              const vNum = trackNumber(videoTrack)
              const aNum = trackNumber(audioTrack)
              const videoEl = (
                showVideoFrames
                  ? <VideoFrameTrack track={videoTrack} zoom={state.zoom} cuts={isRoughCut ? mergedDisplayCuts : EMPTY_CUTS} postCutCuts={isBroll ? effectiveCuts : null} scrollRef={scrollRef} scrollX={scrollX} groupedBelow={item.topIsVideo} groupedAbove={!item.topIsVideo} />
                  : <VideoTrack track={videoTrack} zoom={state.zoom} />
              )
              const audioEl = (
                <AudioTrack track={audioTrack} zoom={state.zoom} cuts={isRoughCut ? userCuts : null} postCutCuts={isBroll ? effectiveCuts : null} scrollRef={scrollRef} scrollX={scrollX} groupedBelow={!item.topIsVideo} groupedAbove={item.topIsVideo} />
              )
              const videoLabel = (
                <div
                  onMouseDown={(e) => handleTrackDragStart(e, item.videoAbsIdx)}
                  style={{ height: `${item.vH}px` }}
                  className={`border-r border-white/10 flex items-center pl-2 pr-3 text-[10px] font-bold gap-1.5 cursor-grab active:cursor-grabbing select-none ${vSelected ? 'text-primary-fixed bg-primary-container/5' : 'text-on-surface-variant'}`}
                >
                  <span className="material-symbols-outlined text-[12px] shrink-0 opacity-30">drag_indicator</span>
                  <span className="w-5 shrink-0">V{vNum}</span>
                  <div className={`h-3 w-[1px] shrink-0 ${vSelected ? 'bg-primary-fixed/30' : 'bg-white/30'}`} />
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_VISIBILITY', payload: videoTrack.id }) }}
                    className="material-symbols-outlined text-[9px] shrink-0"
                    style={videoTrack.visible ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                  >
                    {videoTrack.visible ? 'visibility' : 'visibility_off'}
                  </button>
                </div>
              )
              const audioLabel = (
                <div
                  onMouseDown={(e) => handleTrackDragStart(e, item.audioAbsIdx)}
                  style={{ height: `${item.aH}px` }}
                  className={`border-r border-white/5 flex items-center pl-2 pr-3 text-[10px] font-bold gap-1.5 cursor-grab active:cursor-grabbing select-none ${aSelected ? 'text-primary-fixed bg-primary-container/5' : 'text-on-surface-variant'}`}
                >
                  <span className="material-symbols-outlined text-[12px] shrink-0 opacity-30">drag_indicator</span>
                  <span className="w-5 shrink-0">A{aNum}</span>
                  <div className={`h-3 w-[1px] shrink-0 ${aSelected ? 'bg-primary-fixed/30' : 'bg-white/30'}`} />
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_MUTE', payload: audioTrack.id }) }}
                    className="material-symbols-outlined text-[9px] shrink-0"
                    style={!audioTrack.muted ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                  >
                    {audioTrack.muted ? 'volume_off' : 'volume_up'}
                  </button>
                  <div className={`h-3 w-[1px] shrink-0 ${aSelected ? 'bg-primary-fixed/30' : 'bg-white/30'}`} />
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_TRANSCRIPT', payload: audioTrack.id }) }}
                    className="material-symbols-outlined text-[9px] shrink-0"
                    style={audioTrack.showTranscript ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                  >
                    text_fields
                  </button>
                </div>
              )
              // CapCut-style cut-edge dragging on the selected segment.
              // pairLayout has segments {x, w, origStart, origEnd} in track-local
              // post-cut pixels; segKey = audioTrack.offset + seg.origStart is the
              // canonical cross-track selection key (V and A share track.offset).
              // Each segment "owns" the cut that follows it (a-roll #N + cut #N is
              // one unit) — only the right edge is draggable. The left edge is
              // owned by the previous a-roll, so clicking a-roll #2 doesn't let
              // you drag back into cut #1.
              const pairLayout = isBroll
                ? getTrackPostCutLayout(audioTrack.offset, audioTrack.duration, effectiveCuts, state.zoom)
                : null
              const pairOuterLeft = pairLayout
                ? postCutTime(audioTrack.offset, effectiveCuts) * state.zoom
                : 0
              const selectedSeg = (pairLayout && selectedSegmentKey != null)
                ? pairLayout.segments.find(s => Math.abs(audioTrack.offset + s.origStart - selectedSegmentKey) < 0.01)
                : null
              const segGlobalEnd = selectedSeg ? audioTrack.offset + selectedSeg.origEnd : null
              const followingCut = selectedSeg
                ? userCuts.find(c => Math.abs(c.start - segGlobalEnd) < 0.05 && c.end > c.start)
                : null
              return (
                <div
                  key={`pair-${videoTrack.id}-${audioTrack.id}`}
                  className="relative"
                  style={isDragSource ? { opacity: 0.5, zIndex: 30, transform: `translateY(${dragState.dy}px)`, pointerEvents: 'none' } : undefined}
                >
                  {showInsertBefore && (
                    <div className="absolute top-0 left-0 right-0 h-[3px] bg-primary-fixed z-20 shadow-[0_0_8px_rgba(206,252,0,0.7)] rounded-full" />
                  )}
                  <div className="flex">
                    {/* Sticky label area — top label is whichever track is first
                        in state.tracks; bottom is the other. */}
                    <div className="sticky left-0 w-36 shrink-0 z-30 bg-surface-container border-b border-white/5">
                      {item.topIsVideo ? videoLabel : audioLabel}
                      {item.topIsVideo ? audioLabel : videoLabel}
                    </div>
                    {/* Combined content stacked in matching order */}
                    <div className="flex-1 relative">
                      {item.topIsVideo ? videoEl : audioEl}
                      {item.topIsVideo ? audioEl : videoEl}
                      {/* Selection border overlay — wraps the whole V+A clip
                          uniformly (top of V, sides, bottom of A or transcript).
                          Rendered at pair-row level so V is always highlighted
                          even if videoTrack.offset differs slightly from
                          audioTrack.offset. pointer-events:none lets clicks
                          pass through to the per-segment accents below. */}
                      {selectedSeg && (
                        <div
                          className="absolute pointer-events-none z-[10]"
                          style={{
                            left: `${pairOuterLeft + selectedSeg.x + 2}px`,
                            top: 0,
                            width: `${Math.max(selectedSeg.w - 4, 2)}px`,
                            height: `${item.h}px`,
                            border: '2px solid rgba(255,255,255,0.9)',
                            borderRadius: '6px',
                            boxSizing: 'border-box',
                          }}
                        />
                      )}
                      {/* Cut-edge drag handle on the selected segment's right
                          edge. Drags the START of the following cut (the cut
                          this a-roll "owns"). Dragging right past the cut's
                          end removes it entirely. The left edge is intentionally
                          not draggable — that boundary belongs to the previous
                          a-roll's drag handle. */}
                      {selectedSeg && followingCut && (
                        <div
                          data-testid="seg-drag-cut-start"
                          title="Drag to adjust cut"
                          className="absolute cursor-col-resize z-[15] group"
                          style={{
                            left: `${pairOuterLeft + selectedSeg.x + selectedSeg.w - 5}px`,
                            top: 0,
                            height: `${item.h}px`,
                            width: '10px',
                          }}
                          onMouseDown={(e) => handleFollowingCutDrag(followingCut, e)}
                        >
                          <div className="absolute inset-0 group-hover:bg-primary-fixed/15 transition-colors" />
                          <div className="absolute top-1 bottom-1 left-1/2 w-[3px] -translate-x-1/2 rounded-full bg-primary-fixed shadow-[0_0_6px_rgba(206,252,0,0.7)] group-hover:w-[4px] transition-all" />
                        </div>
                      )}
                    </div>
                  </div>
                  {showInsertAfter && (
                    <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-primary-fixed z-20 shadow-[0_0_8px_rgba(206,252,0,0.7)] rounded-full" />
                  )}
                </div>
              )
            }

            // Regular audio/video track row
            const track = state.tracks[absIdx]
            if (!track) return null
            const selected = state.selectedTrackIds.has(track.id)
            const num = trackNumber(track)
            const isVideo = track.type === 'video'
            const groupedBelow = item.groupedBelow

            return (
              <div
                key={track.id}
                className="relative"
                style={isDragSource ? { opacity: 0.5, zIndex: 30, transform: `translateY(${dragState.dy}px)`, pointerEvents: 'none' } : undefined}
              >
                {showInsertBefore && (
                  <div className="absolute top-0 left-0 right-0 h-[3px] bg-primary-fixed z-20 shadow-[0_0_8px_rgba(206,252,0,0.7)] rounded-full" />
                )}
                <div className="flex">
                  {/* Sticky label — drag to reorder. Bottom border is suppressed
                      when this track is grouped above its sibling (paired
                      audio+video for the same source) so the row reads as one
                      CapCut-style clip instead of two separate tracks. */}
                  <div
                    onMouseDown={(e) => handleTrackDragStart(e, absIdx)}
                    style={isVideo ? { height: '40px' } : { height: track.showTranscript ? '48px' : '24px' }}
                    className={`sticky left-0 w-36 shrink-0 border-r ${isVideo ? 'border-white/10' : 'border-white/5'} ${groupedBelow ? '' : (isVideo ? 'border-b border-white/10' : 'border-b border-white/5')} flex items-center pl-2 pr-3 text-[10px] font-bold gap-1.5 cursor-grab active:cursor-grabbing select-none z-30 bg-surface-container ${
                      selected ? 'text-primary-fixed bg-primary-container/5' : 'text-on-surface-variant'
                    } ${isDragSource ? 'ring-1 ring-primary-fixed bg-primary-fixed/10' : ''}`}
                  >
                    <span className={`material-symbols-outlined text-[12px] shrink-0 ${isDragSource ? 'text-primary-fixed opacity-100' : 'opacity-30'}`}>drag_indicator</span>
                    <span className="w-5 shrink-0">{isVideo ? `V${num}` : `A${num}`}</span>
                    <div className={`h-3 w-[1px] shrink-0 ${selected ? 'bg-primary-fixed/30' : 'bg-white/30'}`} />
                    {isVideo ? (
                      <button
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_VISIBILITY', payload: track.id }) }}
                        className="material-symbols-outlined text-[9px] shrink-0"
                        style={track.visible ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                      >
                        {track.visible ? 'visibility' : 'visibility_off'}
                      </button>
                    ) : (
                      <>
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_MUTE', payload: track.id }) }}
                          className="material-symbols-outlined text-[9px] shrink-0"
                          style={!track.muted ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                        >
                          {track.muted ? 'volume_off' : 'volume_up'}
                        </button>
                        <div className={`h-3 w-[1px] shrink-0 ${selected ? 'bg-primary-fixed/30' : 'bg-white/30'}`} />
                        <button
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_TRANSCRIPT', payload: track.id }) }}
                          className="material-symbols-outlined text-[9px] shrink-0"
                          style={track.showTranscript ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
                        >
                          text_fields
                        </button>
                      </>
                    )}
                  </div>
                  <div className="flex-1 relative">
                    {isVideo
                      ? (showVideoFrames
                          ? <VideoFrameTrack track={track} zoom={state.zoom} cuts={isRoughCut ? mergedDisplayCuts : EMPTY_CUTS} postCutCuts={isBroll ? effectiveCuts : null} scrollRef={scrollRef} scrollX={scrollX} groupedBelow={groupedBelow} groupedAbove={item.groupedAbove} />
                          : <VideoTrack track={track} zoom={state.zoom} />)
                      : <AudioTrack track={track} zoom={state.zoom} cuts={isRoughCut ? userCuts : null} postCutCuts={isBroll ? effectiveCuts : null} scrollRef={scrollRef} scrollX={scrollX} groupedBelow={groupedBelow} groupedAbove={item.groupedAbove} />
                    }
                  </div>
                </div>
                {showInsertAfter && (
                  <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-primary-fixed z-20 shadow-[0_0_8px_rgba(206,252,0,0.7)] rounded-full" />
                )}
              </div>
            )
          })}

          {/* Cuts are no longer drawn as a separate purple junction bar — each
              kept segment of V/A renders with its own rounded corners (per-segment
              accent in VideoFrameTrack/AudioTrack), so cut joins are visible as
              the gap between adjacent rounded clip blocks. */}

          {/* Unified playhead — spans ruler + all tracks.
              Transform is owned exclusively by the rAF playback engine (EditorView tick + seek)
              and by the zoom useLayoutEffect below. Do NOT bind transform from React render state
              or the 60fps engine and 10Hz React will fight and the marker will jump. */}
          <div
            ref={playheadRef}
            className="absolute top-0 h-full w-[2px] bg-primary-fixed pointer-events-none z-20"
            style={{ left: '9rem' }}
          >
            <div className="sticky top-1 w-3.5 h-3.5 bg-primary-fixed rotate-45 rounded-sm" style={{ marginLeft: '-6px' }} />
          </div>
        </div>
      </div>


      {/* Context menu */}
      {state.contextMenu && ctxTrack && (
        <div
          className="fixed z-50 bg-surface-container-high border border-white/10 rounded-lg shadow-2xl py-1 min-w-[160px]"
          style={{ left: state.contextMenu.x, top: state.contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {ctxTrack.groupId && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 text-on-surface"
              onClick={() => {
                dispatch({ type: 'UNGROUP_TRACK', payload: { trackId: ctxTrack.id } })
                dispatch({ type: 'CLOSE_CONTEXT_MENU' })
              }}
            >
              Ungroup track
            </button>
          )}
          {!ctxTrack.groupId && state.selectedTrackIds.size >= 2 && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 text-on-surface"
              onClick={() => {
                dispatch({ type: 'GROUP_TRACKS', payload: { trackIds: [...state.selectedTrackIds] } })
                dispatch({ type: 'CLOSE_CONTEXT_MENU' })
              }}
            >
              Group selected tracks
            </button>
          )}
          {ctxTrack.offset !== ctxTrack.originalOffset && (
            <button
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 text-[#ff7351]"
              onClick={() => {
                dispatch({ type: 'RESYNC_TRACK', payload: ctxTrack.id })
                dispatch({ type: 'CLOSE_CONTEXT_MENU' })
              }}
            >
              Re-sync to original
            </button>
          )}
          <button
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 text-on-surface"
            onClick={() => {
              dispatch({ type: 'SPLIT_TRACK', payload: { trackId: ctxTrack.id, time: state.currentTime } })
              dispatch({ type: 'CLOSE_CONTEXT_MENU' })
            }}
          >
            Split at playhead
          </button>
        </div>
      )}
    </div>
  )
}

