import { useContext, useEffect, useRef, useMemo } from 'react'
import { EditorContext } from './EditorView.jsx'
import { formatTime } from './useEditorState.js'

export default function RoughCutPreview() {
  const { state, videoRefs } = useContext(EditorContext)

  const videoTracks = state.tracks.filter(t => t.type === 'video')
  const isMainMode = state.roughCutTrackMode === 'main'

  // In Main Track mode, compute non-overlapping segments to find the active video
  const mainSegments = useMemo(() => {
    if (!isMainMode) return null
    const sorted = [...videoTracks].sort((a, b) => a.offset - b.offset)
    const segments = []
    let covered = 0
    for (const track of sorted) {
      const trackEnd = track.offset + track.duration
      if (trackEnd <= covered) continue
      const segStart = Math.max(track.offset, covered)
      if (segStart >= trackEnd) continue
      segments.push({ start: segStart, end: trackEnd, videoId: track.videoId, track })
      covered = trackEnd
    }
    return segments
  }, [isMainMode, videoTracks])

  // Find the active video at current playhead time
  const activeTrack = useMemo(() => {
    if (isMainMode && mainSegments?.length) {
      const seg = mainSegments.find(s => state.currentTime >= s.start && state.currentTime < s.end)
      return seg?.track || mainSegments[0].track
    }
    return videoTracks[0] || null
  }, [isMainMode, mainSegments, state.currentTime, videoTracks])

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

  const src = track.filePath ? `/uploads/videos/${track.filePath.split('/').pop()}` : null
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
