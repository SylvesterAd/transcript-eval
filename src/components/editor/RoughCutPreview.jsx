import { useContext, useEffect, useRef, useMemo } from 'react'
import { EditorContext } from './EditorView.jsx'
import { formatTime } from './useEditorState.js'

export default function RoughCutPreview() {
  const { state, videoRefs, totalDuration } = useContext(EditorContext)

  const videoTracks = state.tracks.filter(t => t.type === 'video')
  const isMainMode = state.roughCutTrackMode === 'main'

  // In Main Track mode, merge overlapping tracks into segments
  const mainSegments = useMemo(() => {
    if (!isMainMode) return null
    const sorted = [...videoTracks].sort((a, b) => a.offset - b.offset)
    const segments = []
    let cur = null
    for (const track of sorted) {
      const trackEnd = track.offset + track.duration
      if (cur && track.offset < cur.end) {
        cur.end = Math.max(cur.end, trackEnd)
      } else {
        cur = { start: track.offset, end: trackEnd, videoId: track.videoId, track }
        segments.push(cur)
      }
    }
    return segments
  }, [isMainMode, videoTracks])

  // Find the active video at current playhead time (with video override support)
  const activeTrack = useMemo(() => {
    if (isMainMode && mainSegments?.length) {
      // Search backwards: find the last segment whose start <= currentTime
      // (handles boundaries and gaps without falling back to segment 0)
      let segIdx = 0
      for (let i = mainSegments.length - 1; i >= 0; i--) {
        if (state.currentTime >= mainSegments[i].start) { segIdx = i; break }
      }
      const seg = mainSegments[segIdx]
      const idx = segIdx
      // Check for video override
      const ov = state.segmentVideoOverrides[idx]
      if (ov) {
        const ovTrack = videoTracks.find(t => t.videoId === ov)
        if (ovTrack && state.currentTime >= ovTrack.offset && state.currentTime < ovTrack.offset + ovTrack.duration) {
          return ovTrack
        }
      }
      return seg?.track || mainSegments[0].track
    }
    return videoTracks[0] || null
  }, [isMainMode, mainSegments, state.currentTime, state.segmentVideoOverrides, videoTracks])

  const localTime = activeTrack ? state.currentTime - activeTrack.offset : 0
  const beforeStart = activeTrack && localTime < 0
  const afterEnd = activeTrack && localTime > activeTrack.duration

  return (
    <div className="flex-1 flex items-center justify-center bg-black rounded-xl overflow-hidden relative">
      {activeTrack ? (
        <>
          {/* All videos — only the active one is visible */}
          {videoTracks.map(track => (
            <PreviewVideo
              key={track.id}
              track={track}
              videoRefs={videoRefs}
              visible={track.videoId === activeTrack.videoId}
            />
          ))}
          {/* Overlay for out-of-range */}
          {(beforeStart || afterEnd) && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70">
              <span className="text-on-surface-variant text-xs font-mono">
                {beforeStart ? `Starts at ${formatTime(activeTrack.offset)}` : `Ended at ${formatTime(activeTrack.offset + activeTrack.duration)}`}
              </span>
            </div>
          )}
        </>
      ) : (
        <span className="text-on-surface-variant text-sm">No video tracks</span>
      )}
      {/* Duration overlay */}
      <div className="absolute bottom-2 right-2 flex items-center gap-3 bg-black/60 backdrop-blur-md px-2.5 py-1 rounded-md pointer-events-none z-10">
        <span className="text-[10px] font-mono text-on-surface-variant">
          Total: {formatTime(totalDuration)}
        </span>
        {state.cuts.length > 0 && (
          <span className="text-[10px] font-mono text-primary-fixed">
            After cuts: {formatTime(Math.max(0, totalDuration - state.cuts.reduce((s, c) => s + Math.max(0, Math.min(c.end, totalDuration) - Math.max(c.start, 0)), 0)))}
          </span>
        )}
      </div>
    </div>
  )
}

function PreviewVideo({ track, videoRefs, visible }) {
  const ref = useRef(null)

  useEffect(() => {
    if (ref.current) {
      videoRefs.current[track.videoId] = ref.current
    }
    return () => { delete videoRefs.current[track.videoId] }
  }, [track.videoId, videoRefs])

  // Rough cut editor uses Cloudflare MP4 (frame-accurate seeking) or direct source URL
  const cfMp4 = track.cfStreamUid ? `https://videodelivery.net/${track.cfStreamUid}/downloads/default.mp4` : null
  const directSrc = track.filePath?.startsWith('http') ? track.filePath : track.filePath ? `/uploads/videos/${track.filePath.split('/').pop()}` : null
  const src = cfMp4 || directSrc

  if (!src) return null

  return (
    <video
      ref={ref}
      src={src}
      className={visible ? 'max-w-full max-h-full object-contain' : 'absolute w-px h-px opacity-0 pointer-events-none overflow-hidden'}
      preload="auto"
      playsInline
      muted
    />
  )
}
