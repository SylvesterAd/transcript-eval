import { useRef, useState, useContext } from 'react'
import { BRollContext } from './useBRollEditorState.js'
import { Play, Pause, X } from 'lucide-react'
import { parseTimecode } from './brollUtils.js'

function formatTime(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function BRollDetailPanel() {
  const broll = useContext(BRollContext)
  if (!broll) return null

  const { selectedPlacement: placement, selectedIndex, selectedResults, selectResult, selectPlacement } = broll
  if (!placement) return null

  const resultIdx = selectedResults[selectedIndex] ?? 0
  const result = placement.results?.[resultIdx]
  const startSec = parseTimecode(placement.start)
  const endSec = parseTimecode(placement.end)

  return (
    <div className="w-80 shrink-0 border-l border-white/10 bg-zinc-900/50 flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
        <span className="text-xs font-medium text-zinc-300">B-Roll Detail</span>
        <button onClick={() => selectPlacement(null)} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300">
          <X size={14} />
        </button>
      </div>

      {/* Video Preview */}
      {result ? (
        <VideoPreview url={result.preview_url || result.url} />
      ) : (
        <div className="aspect-video bg-zinc-800 flex items-center justify-center text-xs text-zinc-500">
          {placement.searchStatus === 'pending' ? 'Search pending' : 'No results'}
        </div>
      )}

      {/* Metadata bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-white/10 text-[10px]">
        <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{formatTime(startSec)} - {formatTime(endSec)}</span>
        <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">{placement.type_group}</span>
        {result?.source && <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 capitalize">{result.source}</span>}
      </div>

      {/* Description */}
      <div className="px-4 py-3 border-b border-white/10 space-y-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Description</div>
          <p className="text-xs text-zinc-300 leading-relaxed">{placement.description}</p>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Purpose</div>
          <p className="text-xs text-zinc-400">{placement.function}</p>
        </div>
      </div>

      {/* Alternatives */}
      {placement.results?.length > 1 && (
        <div className="px-4 py-3">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
            Alternatives ({placement.results.length})
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {placement.results.map((r, i) => (
              <button
                key={r.id || i}
                onClick={() => selectResult(selectedIndex, i)}
                className={`relative rounded overflow-hidden aspect-video ${
                  i === resultIdx
                    ? 'ring-2 ring-teal-400'
                    : 'ring-1 ring-white/10 hover:ring-white/30'
                }`}
              >
                <img
                  src={r.preview_url || r.url}
                  alt={r.title || ''}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1 py-0.5">
                  <span className="text-[8px] text-white/70 truncate block">{r.source}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function VideoPreview({ url }) {
  const videoRef = useRef(null)
  const [playing, setPlaying] = useState(false)

  function togglePlay() {
    if (!videoRef.current) return
    if (videoRef.current.paused) {
      videoRef.current.play()
      setPlaying(true)
    } else {
      videoRef.current.pause()
      setPlaying(false)
    }
  }

  return (
    <div className="relative group cursor-pointer" onClick={togglePlay}>
      <video
        ref={videoRef}
        src={url}
        className="w-full aspect-video object-cover bg-black"
        preload="metadata"
        playsInline
        muted
        onEnded={() => setPlaying(false)}
      />
      <div className={`absolute inset-0 flex items-center justify-center transition-opacity ${playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}>
        <div className="w-10 h-10 rounded-full bg-black/60 flex items-center justify-center">
          {playing ? <Pause size={18} className="text-white" /> : <Play size={18} className="text-white ml-0.5" />}
        </div>
      </div>
    </div>
  )
}
