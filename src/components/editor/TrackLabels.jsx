import { useContext } from 'react'
import { EditorContext } from './EditorView.jsx'

export default function TrackLabels() {
  const { state, dispatch } = useContext(EditorContext)
  const videoTracks = state.tracks.filter(t => t.type === 'video')
  const audioTracks = state.tracks.filter(t => t.type === 'audio')

  const handleClick = (trackId, e) => {
    dispatch({
      type: 'SELECT_TRACK',
      payload: { trackId, shift: e.shiftKey, meta: e.metaKey || e.ctrlKey }
    })
  }

  return (
    <div className="w-32 border-r border-white/5 flex flex-col shrink-0 bg-surface-container z-20">
      {/* Corner space matching ruler */}
      <div className="h-10 border-b border-white/5 bg-surface-container" />

      {/* Video track labels */}
      {!state.audioOnly && videoTracks.map((track, i) => {
        const num = videoTracks.length - i
        const selected = state.selectedTrackIds.has(track.id)
        const isActive = i === videoTracks.length - 1
        return (
          <div
            key={track.id}
            onClick={(e) => handleClick(track.id, e)}
            className={`h-6 flex items-center px-2 border-b border-white/10 text-[10px] font-bold gap-2 cursor-grab ${
              isActive
                ? 'text-primary-fixed bg-primary-container/5'
                : selected ? 'text-primary-fixed bg-primary-container/5' : 'text-on-surface-variant'
            }`}
          >
            <span className="material-symbols-outlined text-[14px] opacity-30">drag_indicator</span>
            <span className="w-4">V{num}</span>
            <div className="h-3 w-[1px] bg-white/10 mx-0.5" />
            <button
              onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_VISIBILITY', payload: track.id }) }}
              className="material-symbols-outlined text-[14px]"
              style={track.visible ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
            >
              {track.visible ? 'visibility' : 'visibility_off'}
            </button>
          </div>
        )
      })}

      {/* Audio track labels */}
      {audioTracks.map((track, i) => {
        const selected = state.selectedTrackIds.has(track.id)
        return (
          <div
            key={track.id}
            onClick={(e) => handleClick(track.id, e)}
            className={`h-28 flex items-center px-2 border-b border-white/5 text-[10px] font-bold gap-2 cursor-grab ${
              selected ? 'text-primary-fixed bg-primary-container/5' : 'text-on-surface-variant'
            }`}
          >
            <span className="material-symbols-outlined text-[14px] opacity-30">drag_indicator</span>
            <span className="w-4">A{i + 1}</span>
            <div className="h-16 w-[1px] bg-white/10 mx-0.5" />
            <button
              onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_MUTE', payload: track.id }) }}
              className="material-symbols-outlined text-[14px]"
              style={!track.muted ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
            >
              {track.muted ? 'volume_off' : 'volume_up'}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); dispatch({ type: 'TOGGLE_TRANSCRIPT', payload: track.id }) }}
              className="material-symbols-outlined text-[14px] ml-1"
              style={track.showTranscript ? { fontVariationSettings: '"FILL" 1', color: '#cefc00' } : { opacity: 0.4 }}
            >
              text_fields
            </button>
          </div>
        )
      })}
    </div>
  )
}
