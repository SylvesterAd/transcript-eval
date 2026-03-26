import { useContext, useRef, useMemo, useCallback, useEffect } from 'react'
import { EditorContext } from './EditorView.jsx'
import { GROUP_COLORS } from './useEditorState.js'
import WaveformData from 'waveform-data'

/**
 * Logarithmic (dB) scaling — same approach as Premiere Pro.
 * Boosts quiet sounds visually so dynamics are always visible.
 * -60dB floor.
 */
function logScale(linear) {
  if (linear <= 0) return 0
  const db = 20 * Math.log10(linear)
  const floor = -60
  if (db <= floor) return 0
  return (db - floor) / -floor
}

/**
 * Draw rectified, log-scaled waveform bars on a Canvas context.
 * Handles both 1:1 (resampled) and stretched (zoomed-in beyond data resolution) modes.
 */
function drawWaveform(ctx, channel, length, width, height, color) {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = color
  const step = width / length  // pixels per peak (>=1 when stretched, 1 when resampled)
  const barW = Math.max(1, Math.ceil(step))

  for (let i = 0; i < length; i++) {
    const minVal = channel.min_sample(i)
    const maxVal = channel.max_sample(i)
    const amp = Math.max(Math.abs(minVal), Math.abs(maxVal)) / 128
    const scaled = logScale(amp)
    const barH = scaled * height
    if (barH < 0.5) continue
    const x = Math.round(i * step)
    ctx.globalAlpha = 0.6 + 0.35 * scaled
    ctx.fillRect(x, height - barH, barW, barH)
  }
}

export function VideoTrack({ track, zoom }) {
  const { state, dispatch } = useContext(EditorContext)
  const selected = state.selectedTrackIds.has(track.id)
  const group = track.groupId ? state.groups[track.groupId] : null
  const color = group?.color || '#acaaad'
  const isUnsynced = track.offset !== track.originalOffset

  const left = track.offset * zoom
  const width = Math.max(track.duration * zoom, 4)

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startOffset = track.offset

    const onMove = (ev) => {
      const dx = ev.clientX - startX
      const newOffset = startOffset + dx / zoom
      dispatch({ type: 'MOVE_TRACK', payload: { trackId: track.id, newOffset } })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [track.id, track.offset, zoom, dispatch])

  const onContextMenu = useCallback((e) => {
    e.preventDefault()
    dispatch({ type: 'SELECT_TRACK', payload: { trackId: track.id, shift: false, meta: false } })
    dispatch({ type: 'OPEN_CONTEXT_MENU', payload: { x: e.clientX, y: e.clientY, trackId: track.id } })
  }, [track.id, dispatch])

  return (
    <div className={`h-6 border-b border-white/10 flex items-center relative ${selected ? 'bg-primary-container/5' : 'bg-white/[0.02]'}`}>
      <div
        className={`absolute h-4 top-1 flex items-center px-2 rounded-r overflow-hidden text-[8px] font-bold cursor-grab active:cursor-grabbing ${
          selected ? 'active-glow z-10' : ''
        } ${isUnsynced ? 'border border-dashed !border-[#ff7351]' : ''}`}
        style={{
          left: `${left}px`,
          width: `${width}px`,
          backgroundColor: `${color}33`,
          borderLeft: `2px solid ${color}`,
          color: color,
          opacity: track.visible ? 1 : 0.4,
        }}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
      >
        <span className="truncate">{track.title}</span>
      </div>
    </div>
  )
}

const CHUNK_W = 1000 // CSS pixels per canvas chunk

export function AudioTrack({ track, zoom, cuts, scrollRef, scrollX }) {
  const { state, dispatch } = useContext(EditorContext)
  const selected = state.selectedTrackIds.has(track.id)
  const group = track.groupId ? state.groups[track.groupId] : null
  const color = group?.color || '#48e5d0'
  const containerRef = useRef(null)

  // Build WaveformData from min/max peaks (100 peaks/s from server)
  const waveformData = useMemo(() => {
    const peaks = track.waveformPeaks
    if (peaks?.length >= 4) {
      const numPeaks = peaks.length / 2
      return WaveformData.create({
        version: 2,
        channels: 1,
        sample_rate: 44100,
        samples_per_pixel: Math.max(1, Math.round((track.duration * 44100) / numPeaks)),
        bits: 8,
        length: numPeaks,
        data: peaks,
      })
    }
    if (track.waveform?.length) {
      const rms = track.waveform
      const data = new Array(rms.length * 2)
      for (let i = 0; i < rms.length; i++) {
        const v = Math.round((rms[i] / 255) * 127)
        data[i * 2] = -v
        data[i * 2 + 1] = v
      }
      return WaveformData.create({
        version: 2,
        channels: 1,
        sample_rate: 44100,
        samples_per_pixel: Math.max(1, Math.round((track.duration * 44100) / rms.length)),
        bits: 8,
        length: rms.length,
        data,
      })
    }
    return null
  }, [track.waveformPeaks, track.waveform, track.duration])

  // 3-level LOD transcript rendering:
  //   1. Sentence level — whole sentence as one box (zoomed out)
  //   2. Word-group level — adjacent words merged when gap < 3px
  //   3. Individual word level — each word in its own box (zoomed in)
  // Binary search on pre-computed sentences for viewport, per-sentence LOD decision.
  // Sentence boundaries always start a new box.
  const mergedGroups = useMemo(() => {
    const words = track.transcriptWords
    const sentences = track.transcriptSentences
    if (!words?.length) return []

    const viewW = scrollRef?.current?.clientWidth || 1200
    const labelW = 144
    const buffer = 300
    const vStart = Math.max(0, (scrollX - labelW - buffer) / zoom - track.offset)
    const vEnd = (scrollX - labelW + viewW + buffer) / zoom - track.offset

    const AVG_CHAR_W = 5.5 // approx px per char at 9px font
    const PAD_PX = 12 // px-1.5 = 6px each side
    const MIN_GAP_PX = 3
    const groups = []

    if (sentences?.length) {
      // Sentence-aware LOD path — binary search on sentences
      let lo = 0, hi = sentences.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (sentences[mid].end < vStart) lo = mid + 1
        else hi = mid
      }

      for (let si = lo; si < sentences.length; si++) {
        const sent = sentences[si]
        if (sent.start > vEnd) break

        const sentPx = (sent.end - sent.start) * zoom
        const textW = AVG_CHAR_W * sent.text.length

        if (sentPx >= textW * 0.8) {
          // Words fit — render individual words with gap-based merge within sentence
          // Also merge when current box is too narrow for its text (prevents clipped words)
          let cur = null
          for (let wi = sent.firstWord; wi <= sent.lastWord; wi++) {
            const w = words[wi]
            if (!cur) {
              cur = { text: w.word, start: w.start, end: w.end }
            } else {
              const gapTooSmall = (w.start - cur.end) * zoom < MIN_GAP_PX
              const boxTooNarrow = (cur.end - cur.start) * zoom < AVG_CHAR_W * cur.text.length + PAD_PX
              if (gapTooSmall || boxTooNarrow) {
                cur.text += ' ' + w.word
                cur.end = w.end
              } else {
                groups.push(cur)
                cur = { text: w.word, start: w.start, end: w.end }
              }
            }
          }
          if (cur) groups.push(cur)
        } else {
          // Sentence as single box
          groups.push({ text: sent.text, start: sent.start, end: sent.end })
        }
      }
    } else {
      // Fallback: word-only merge (sentences not yet computed)
      let lo = 0, hi = words.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (words[mid].end < vStart) lo = mid + 1
        else hi = mid
      }
      let cur = null
      for (let i = lo; i < words.length; i++) {
        const w = words[i]
        if (w.start > vEnd) break
        if (!cur) {
          cur = { text: w.word, start: w.start, end: w.end }
        } else if ((w.start - cur.end) * zoom < MIN_GAP_PX) {
          cur.text += ' ' + w.word
          cur.end = w.end
        } else {
          groups.push(cur)
          cur = { text: w.word, start: w.start, end: w.end }
        }
      }
      if (cur) groups.push(cur)
    }

    // Post-process: merge any adjacent groups that visually overlap
    // (cross-sentence collisions, min-width pushing into next box)
    const MIN_BOX_W = 4
    const result = []
    for (const g of groups) {
      const prev = result[result.length - 1]
      if (prev) {
        const prevVisualEnd = Math.max(prev.end * zoom, prev.start * zoom + MIN_BOX_W)
        if (g.start * zoom < prevVisualEnd + MIN_GAP_PX) {
          prev.text += ' ' + g.text
          prev.end = g.end
          continue
        }
      }
      result.push(g)
    }
    // Extend display width to fit text, capped by next group's start
    for (let i = 0; i < result.length; i++) {
      const g = result[i]
      const textNeed = (AVG_CHAR_W * g.text.length + PAD_PX) / zoom
      const maxEnd = i < result.length - 1 ? result[i + 1].start - 2 / zoom : g.end + 10
      g.displayEnd = Math.min(maxEnd, Math.max(g.end, g.start + textNeed))
    }
    return result
  }, [track.transcriptWords, track.transcriptSentences, zoom, scrollX, track.offset, scrollRef])

  // Resample for current zoom: downsample via WaveformData.resample() when
  // zoomed out, use base data when zoomed in (bars stretch).
  const resampled = useMemo(() => {
    if (!waveformData) return null
    const fullW = Math.max(Math.round(track.duration * zoom), 4)
    if (fullW < waveformData.length) {
      return waveformData.resample({ width: fullW })
    }
    return waveformData
  }, [waveformData, zoom, track.duration])

  // Chunked canvas rendering with dirty tracking.
  // Splits the waveform into 1000px-wide canvas chunks. Only visible chunks
  // (+ 1 chunk overscan) are mounted in the DOM. On scroll, only newly
  // visible chunks get drawn — existing ones are untouched.
  useEffect(() => {
    const scrollEl = scrollRef?.current
    const container = containerRef.current
    if (!container) return

    const dpr = window.devicePixelRatio || 1
    const fullW = Math.max(Math.round(track.duration * zoom), 4)
    const h = 56 // waveform always 56px — fills half when transcript on, full when off
    const labelW = 144 // w-36 (144px) — no extra margin
    const totalChunks = Math.ceil(fullW / CHUNK_W)
    const pxPerPeak = resampled ? fullW / resampled.length : 1

    const canvases = new Map()

    const drawChunk = (idx) => {
      const canvas = canvases.get(idx)
      if (!canvas) return
      const chunkStart = idx * CHUNK_W
      const chunkEnd = Math.min(fullW, chunkStart + CHUNK_W)
      const w = chunkEnd - chunkStart

      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      canvas.style.left = `${chunkStart}px`

      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)

      if (!resampled) {
        ctx.strokeStyle = color
        ctx.globalAlpha = 0.15
        ctx.beginPath()
        ctx.moveTo(0, h - 0.5)
        ctx.lineTo(w, h - 0.5)
        ctx.stroke()
        return
      }

      const channel = resampled.channel(0)
      ctx.fillStyle = color

      if (pxPerPeak <= 1) {
        // Downsampled: 1 peak ≈ 1 pixel
        const startPeak = chunkStart
        const endPeak = Math.min(resampled.length, chunkEnd)
        for (let i = startPeak; i < endPeak; i++) {
          const amp = Math.max(Math.abs(channel.min_sample(i)), Math.abs(channel.max_sample(i))) / 128
          const scaled = logScale(amp)
          const barH = scaled * h
          if (barH < 0.5) continue
          ctx.globalAlpha = 0.6 + 0.35 * scaled
          ctx.fillRect(i - chunkStart, h - barH, 1, barH)
        }
      } else {
        // Zoomed in: bars stretch beyond 1px
        const startPeak = Math.max(0, Math.floor(chunkStart / pxPerPeak))
        const endPeak = Math.min(resampled.length, Math.ceil(chunkEnd / pxPerPeak))
        const barW = Math.max(1, Math.ceil(pxPerPeak))
        for (let i = startPeak; i < endPeak; i++) {
          const amp = Math.max(Math.abs(channel.min_sample(i)), Math.abs(channel.max_sample(i))) / 128
          const scaled = logScale(amp)
          const barH = scaled * h
          if (barH < 0.5) continue
          const x = Math.round(i * pxPerPeak - chunkStart)
          ctx.globalAlpha = 0.6 + 0.35 * scaled
          ctx.fillRect(x, h - barH, barW, barH)
        }
      }
    }

    const sync = () => {
      const scrollLeft = scrollEl?.scrollLeft || 0
      const viewportW = scrollEl?.clientWidth || 1200
      const offsetPx = track.offset * zoom
      // Visible range relative to the waveform container (which starts at offsetPx)
      const vStart = scrollLeft - labelW - offsetPx
      const vEnd = vStart + viewportW
      const first = Math.max(0, Math.floor((vStart - CHUNK_W) / CHUNK_W))
      const last = Math.min(totalChunks - 1, Math.ceil((vEnd + CHUNK_W) / CHUNK_W))

      // Unmount out-of-range chunks
      for (const [idx, canvas] of canvases) {
        if (idx < first || idx > last) {
          canvas.remove()
          canvases.delete(idx)
        }
      }
      // Mount + draw only new chunks (dirty tracking)
      for (let idx = first; idx <= last; idx++) {
        if (!canvases.has(idx)) {
          const canvas = document.createElement('canvas')
          canvas.style.position = 'absolute'
          canvas.style.top = '0'
          container.appendChild(canvas)
          canvases.set(idx, canvas)
          drawChunk(idx)
        }
      }
    }

    sync()

    let rafId = 0
    const onScroll = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(sync)
    }
    scrollEl?.addEventListener('scroll', onScroll)

    return () => {
      scrollEl?.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(rafId)
      for (const canvas of canvases.values()) canvas.remove()
      canvases.clear()
    }
  }, [resampled, zoom, track.duration, track.offset, color, track.showTranscript, scrollRef])

  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startOffset = track.offset

    const onMove = (ev) => {
      const dx = ev.clientX - startX
      const newOffset = startOffset + dx / zoom
      dispatch({ type: 'MOVE_TRACK', payload: { trackId: track.id, newOffset } })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [track.id, track.offset, zoom, dispatch])

  const onContextMenu = useCallback((e) => {
    e.preventDefault()
    dispatch({ type: 'SELECT_TRACK', payload: { trackId: track.id, shift: false, meta: false } })
    dispatch({ type: 'OPEN_CONTEXT_MENU', payload: { x: e.clientX, y: e.clientY, trackId: track.id } })
  }, [track.id, dispatch])

  return (
    <div
      className={`border-b border-white/5 flex flex-col relative ${selected ? 'track-selected' : ''}`}
      style={{ height: track.showTranscript ? '112px' : '56px' }}
      onContextMenu={onContextMenu}
    >
      {/* Waveform */}
      <div
        className="h-14 w-full relative overflow-hidden cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        {/* Background + left accent — separate from canvas container to avoid border shifting canvas positions */}
        <div
          className="absolute top-0 h-full"
          style={{
            left: `${track.offset * zoom}px`,
            width: `${Math.max(track.duration * zoom, 4)}px`,
            borderLeft: `4px solid ${color}`,
            backgroundColor: `${color}15`,
          }}
        />
        {/* Canvas container — no border so canvas left:0 aligns with container edge */}
        <div ref={containerRef} className="absolute top-0 h-full" style={{ left: `${track.offset * zoom}px` }} />
      </div>

      {/* Cut overlays */}
      {cuts?.map(cut => {
        const cStart = Math.max(track.offset, cut.start)
        const cEnd = Math.min(track.offset + track.duration, cut.end)
        if (cEnd <= cStart) return null
        return (
          <div
            key={cut.id}
            className="absolute top-0 h-full bg-black/50 pointer-events-none z-10"
            style={{ left: `${cStart * zoom}px`, width: `${(cEnd - cStart) * zoom}px` }}
          />
        )
      })}

      {/* Transcript */}
      {track.showTranscript && (
        <div
          className="h-14 w-full relative overflow-hidden"
          onMouseDown={onMouseDown}
        >
          <div
            className="absolute top-0 h-full overflow-hidden"
            style={{
              left: `${track.offset * zoom}px`,
              width: `${Math.max(track.duration * zoom, 4)}px`,
              borderLeft: `4px solid ${color}`,
              backgroundColor: `${color}08`,
            }}
          >
            {mergedGroups.length > 0 ? (
              mergedGroups.map((g) => (
                <div
                  key={g.start}
                  className="absolute top-3 h-8 px-1.5 bg-black/30 rounded border flex items-center text-[9px] font-medium overflow-hidden whitespace-nowrap"
                  style={{
                    left: `${g.start * zoom}px`,
                    width: `${Math.max(((g.displayEnd || g.end) - g.start) * zoom, 4)}px`,
                    borderColor: `${color}30`,
                    color,
                  }}
                >
                  {g.text}
                </div>
              ))
            ) : (
              !track.transcriptWords?.length && (
                <div className="absolute top-3 h-8 w-32 bg-black/20 rounded border border-white/5 opacity-30" />
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const COMPOSITE_CHUNK_W = 1000

/**
 * Composite audio track — single row showing waveforms from multiple audio sources.
 * Each segment draws the waveform from the corresponding audio track.
 * segments: [{start, end, videoId, offset, duration, filePath, groupId, title}]
 */
export function CompositeAudioTrack({ segments, zoom, cuts, scrollRef, scrollX }) {
  const { state } = useContext(EditorContext)
  const containerRef = useRef(null)

  // Map segments to audio tracks + build WaveformData
  const segmentData = useMemo(() => {
    return segments.map((seg, i) => {
      const audioTrack = state.tracks.find(t => t.type === 'audio' && t.videoId === seg.videoId)
      const group = seg.groupId ? state.groups[seg.groupId] : null
      const color = group?.color || GROUP_COLORS[i % GROUP_COLORS.length]

      let waveformData = null
      if (audioTrack) {
        const peaks = audioTrack.waveformPeaks
        if (peaks?.length >= 4) {
          const numPeaks = peaks.length / 2
          waveformData = WaveformData.create({
            version: 2, channels: 1, sample_rate: 44100,
            samples_per_pixel: Math.max(1, Math.round((audioTrack.duration * 44100) / numPeaks)),
            bits: 8, length: numPeaks, data: peaks,
          })
        } else if (audioTrack.waveform?.length) {
          const rms = audioTrack.waveform
          const data = new Array(rms.length * 2)
          for (let i = 0; i < rms.length; i++) {
            const v = Math.round((rms[i] / 255) * 127)
            data[i * 2] = -v
            data[i * 2 + 1] = v
          }
          waveformData = WaveformData.create({
            version: 2, channels: 1, sample_rate: 44100,
            samples_per_pixel: Math.max(1, Math.round((audioTrack.duration * 44100) / rms.length)),
            bits: 8, length: rms.length, data,
          })
        }
      }

      return { ...seg, audioTrack, color, waveformData }
    })
  }, [segments, state.tracks, state.groups])

  // Chunked canvas rendering — same approach as AudioTrack
  useEffect(() => {
    const scrollEl = scrollRef?.current
    const container = containerRef.current
    if (!container || !segmentData.length) return

    const dpr = window.devicePixelRatio || 1
    const h = 56
    const labelW = 144
    const totalEnd = segmentData[segmentData.length - 1].end
    const totalW = Math.max(Math.round(totalEnd * zoom), 4)
    const totalChunks = Math.ceil(totalW / COMPOSITE_CHUNK_W)
    const canvases = new Map()

    const drawChunk = (idx) => {
      const canvas = canvases.get(idx)
      if (!canvas) return
      const chunkStartPx = idx * COMPOSITE_CHUNK_W
      const chunkEndPx = Math.min(totalW, chunkStartPx + COMPOSITE_CHUNK_W)
      const w = chunkEndPx - chunkStartPx

      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      canvas.style.left = `${chunkStartPx}px`

      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)

      for (const seg of segmentData) {
        if (!seg.waveformData || !seg.audioTrack) continue
        const segStartPx = seg.start * zoom
        const segEndPx = seg.end * zoom
        if (segEndPx <= chunkStartPx || segStartPx >= chunkEndPx) continue

        const peaksPerSecond = seg.waveformData.length / seg.audioTrack.duration
        const pxPerPeak = (seg.audioTrack.duration * zoom) / seg.waveformData.length
        const channel = seg.waveformData.channel(0)
        ctx.fillStyle = seg.color

        // Map chunk pixel range to audio peaks
        const drawStartTime = Math.max(seg.start, chunkStartPx / zoom) - seg.audioTrack.offset
        const drawEndTime = Math.min(seg.end, chunkEndPx / zoom) - seg.audioTrack.offset
        const startPeak = Math.max(0, Math.floor(drawStartTime * peaksPerSecond))
        const endPeak = Math.min(seg.waveformData.length, Math.ceil(drawEndTime * peaksPerSecond))

        for (let i = startPeak; i < endPeak; i++) {
          const amp = Math.max(Math.abs(channel.min_sample(i)), Math.abs(channel.max_sample(i))) / 128
          const scaled = logScale(amp)
          const barH = scaled * h
          if (barH < 0.5) continue
          const peakTimeline = seg.audioTrack.offset + (i / peaksPerSecond)
          const x = peakTimeline * zoom - chunkStartPx
          const barW = Math.max(1, Math.ceil(pxPerPeak))
          ctx.globalAlpha = 0.6 + 0.35 * scaled
          ctx.fillRect(x, h - barH, barW, barH)
        }
      }
    }

    const sync = () => {
      const scrollLeft = scrollEl?.scrollLeft || 0
      const viewportW = scrollEl?.clientWidth || 1200
      const vStart = scrollLeft - labelW
      const vEnd = vStart + viewportW
      const first = Math.max(0, Math.floor((vStart - COMPOSITE_CHUNK_W) / COMPOSITE_CHUNK_W))
      const last = Math.min(totalChunks - 1, Math.ceil((vEnd + COMPOSITE_CHUNK_W) / COMPOSITE_CHUNK_W))

      for (const [idx, canvas] of canvases) {
        if (idx < first || idx > last) {
          canvas.remove()
          canvases.delete(idx)
        }
      }
      for (let idx = first; idx <= last; idx++) {
        if (!canvases.has(idx)) {
          const canvas = document.createElement('canvas')
          canvas.style.position = 'absolute'
          canvas.style.top = '0'
          container.appendChild(canvas)
          canvases.set(idx, canvas)
          drawChunk(idx)
        }
      }
    }

    sync()

    let rafId = 0
    const onScroll = () => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(sync)
    }
    scrollEl?.addEventListener('scroll', onScroll)

    return () => {
      scrollEl?.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(rafId)
      for (const canvas of canvases.values()) canvas.remove()
      canvases.clear()
    }
  }, [segmentData, zoom, scrollRef])

  return (
    <div className="relative border-b border-white/5" style={{ height: '56px' }}>
      {/* Background + accent per segment */}
      {segmentData.map((seg, si) => (
        <div
          key={`bg-${seg.videoId}-${seg.start}`}
          className="absolute top-0 h-full"
          style={{ left: `${seg.start * zoom}px`, width: `${(seg.end - seg.start) * zoom}px` }}
        >
          <div className="absolute inset-0" style={{ backgroundColor: `${seg.color}15`, borderLeft: `4px solid ${seg.color}` }} />
          {si > 0 && <div className="absolute left-0 top-0 w-[2px] h-full bg-white/40 z-10" />}
          <div className="absolute top-1 right-1 bg-black/60 px-1.5 py-0.5 rounded text-[8px] font-bold z-10" style={{ color: seg.color }}>
            {seg.title || `A${si + 1}`}
          </div>
        </div>
      ))}

      {/* Waveform canvases */}
      <div ref={containerRef} className="absolute inset-0 overflow-hidden" />

      {/* Cut overlays */}
      {cuts?.map(cut => {
        const totalStart = segments[0]?.start || 0
        const totalEnd = segments[segments.length - 1]?.end || 0
        const cStart = Math.max(totalStart, cut.start)
        const cEnd = Math.min(totalEnd, cut.end)
        if (cEnd <= cStart) return null
        return (
          <div key={cut.id} className="absolute inset-y-0 bg-black/50 pointer-events-none z-20" style={{ left: `${cStart * zoom}px`, width: `${(cEnd - cStart) * zoom}px` }} />
        )
      })}
    </div>
  )
}
