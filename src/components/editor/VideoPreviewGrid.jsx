import { useContext, useEffect, useRef } from 'react'
import { EditorContext } from './EditorView.jsx'
import { formatTime } from './useEditorState.js'

function gridClass(count) {
  if (count <= 1) return 'grid-cols-1 grid-rows-1'
  if (count === 2) return 'grid-cols-2 grid-rows-1'
  if (count <= 4) return 'grid-cols-2 grid-rows-2'
  if (count <= 6) return 'grid-cols-3 grid-rows-2'
  if (count <= 9) return 'grid-cols-3 grid-rows-3'
  return 'grid-cols-4 grid-rows-3'
}

export default function VideoPreviewGrid() {
  const { state, videoRefs } = useContext(EditorContext)
  const videoTracks = state.tracks.filter(t => t.type === 'video' && t.visible)
  const order = state.originalVideoOrder || []

  return (
    <div className={`flex-1 grid ${gridClass(videoTracks.length)} gap-2 bg-black rounded-xl overflow-hidden shadow-2xl p-2`}>
      {videoTracks.map(track => {
        const num = Math.max(1, order.indexOf(track.id) + 1)
        return <VideoCell key={track.id} track={track} num={num} videoRefs={videoRefs} currentTime={state.currentTime} state={state} />
      })}
      {videoTracks.length === 0 && (
        <div className="flex items-center justify-center text-on-surface-variant text-sm">No visible video tracks</div>
      )}
    </div>
  )
}

function VideoCell({ track, num, videoRefs, currentTime, state }) {
  const ref = useRef(null)
  const localTime = currentTime - track.offset
  const beforeStart = localTime < 0
  const afterEnd = localTime > track.duration
  const audioTrack = state.tracks.find(t => t.type === 'audio' && t.videoId === track.videoId)
  const isMuted = audioTrack?.muted !== false

  useEffect(() => {
    if (ref.current) {
      videoRefs.current[track.videoId] = ref.current
    }
    return () => { delete videoRefs.current[track.videoId] }
  }, [track.videoId, videoRefs])

  const src = track.filePath ? `/uploads/videos/${track.filePath.split('/').pop()}` : null

  return (
    <div className="relative bg-surface-container-low rounded-lg overflow-hidden border border-white/5 group">
      {src ? (
        <video
          ref={ref}
          src={src}
          className="w-full h-full object-cover"
          preload="auto"
          playsInline
          muted
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-surface-container-low text-on-surface-variant text-xs">
          No video
        </div>
      )}
      <div className="absolute top-2 left-2 flex flex-col gap-1">
        <div className="bg-black/60 backdrop-blur-sm px-2 py-0.5 rounded text-[10px] font-mono text-primary-fixed border border-primary-fixed/20">
          {track.title}
        </div>
        <div className="flex gap-1">
          <span className="bg-black/60 backdrop-blur-sm px-1.5 py-0.5 rounded text-[9px] font-bold text-on-surface-variant border border-white/10">
            V{num}
          </span>
          <span className={`backdrop-blur-sm px-1.5 py-0.5 rounded text-[9px] font-bold border ${
            isMuted ? 'bg-black/60 text-on-surface-variant/40 border-white/5' : 'bg-black/60 text-primary-fixed border-primary-fixed/20'
          }`}>
            A{num}{isMuted ? '' : ' ♪'}
          </span>
        </div>
      </div>
      {(beforeStart || afterEnd) && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70">
          <span className="text-on-surface-variant text-xs font-mono">
            {beforeStart ? `Starts at ${formatTime(track.offset)}` : `Ended at ${formatTime(track.offset + track.duration)}`}
          </span>
        </div>
      )}
    </div>
  )
}
