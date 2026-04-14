import { useRef, useState, useContext } from 'react'
import { BRollContext } from './useBRollEditorState.js'
import { Play, Pause, X, Search, Loader2, RotateCw, Pencil, Trash2 } from 'lucide-react'
import { parseTimecode } from './brollUtils.js'

function formatTime(s) {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function BRollDetailPanel() {
  const broll = useContext(BRollContext)
  const [showEditModal, setShowEditModal] = useState(false)
  const [retrying, setRetrying] = useState(false)
  if (!broll) return null

  const { selectedPlacement: placement, selectedIndex, selectedResults, selectResult, selectPlacement } = broll
  if (!placement) return null

  const resultIdx = selectedResults[selectedIndex] ?? 0
  const result = placement.results?.[resultIdx]
  const startSec = placement.timelineStart ?? parseTimecode(placement.start)
  const endSec = placement.timelineEnd ?? parseTimecode(placement.end)

  async function handleRetry() {
    setRetrying(true)
    try { await broll.searchPlacement(selectedIndex) } catch {}
    setRetrying(false)
  }

  function handleDelete() {
    broll.hidePlacement(selectedIndex)
    broll.selectPlacement(null)
  }

  return (
    <div className="w-80 shrink-0 border-l border-white/5 bg-[#141416] flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <span className="text-sm font-semibold text-zinc-200">B-Roll Detail</span>
        <button onClick={() => selectPlacement(null)} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300">
          <X size={14} />
        </button>
      </div>

      {/* Metadata row: Time, Type, Source, Purpose */}
      <div className="px-4 pt-4 pb-3">
        <div className="flex items-center gap-3 text-xs flex-wrap">
          <div>
            <span className="text-zinc-600 text-[10px]">Time</span>
            <div className="text-zinc-300 font-mono text-[11px]">{formatTime(startSec)} - {formatTime(endSec)}</div>
          </div>
          <div className="w-px h-6 bg-white/5" />
          <div>
            <span className="text-zinc-600 text-[10px]">Type</span>
            <div className="text-zinc-300 text-[11px]">{placement.type_group}</div>
          </div>
          <div className="w-px h-6 bg-white/5" />
          <div>
            <span className="text-zinc-600 text-[10px]">Source</span>
            <div className="text-zinc-300 text-[11px]">{result?.source || placement.source_feel || '—'}</div>
          </div>
          {placement.function && (
            <>
              <div className="w-px h-6 bg-white/5" />
              <div>
                <span className="text-zinc-600 text-[10px]">Purpose</span>
                <div className="text-zinc-300 text-[11px]">{placement.function}</div>
              </div>
            </>
          )}
        </div>
        {placement.audio_anchor && (
          <div className="mt-2">
            <span className="text-zinc-600 text-[10px]">Audio Anchor</span>
            <div className="text-zinc-400 text-[11px] italic leading-relaxed">"{placement.audio_anchor}"</div>
          </div>
        )}
      </div>

      {/* Video Preview */}
      <div className="px-4 pb-2">
        {result ? (
          <VideoPreview url={result.preview_url_hq || result.preview_url || result.url} thumbnail={result.thumbnail_url} />
        ) : (
          <SearchPrompt placement={placement} index={selectedIndex} searchPlacement={broll.searchPlacement} />
        )}
      </div>

      {/* Action buttons — Edit / Retry / Delete */}
      <div className="flex items-center gap-1.5 px-4 pb-3">
        <button
          onClick={() => setShowEditModal(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-[11px] font-medium transition-colors"
        >
          <Pencil size={11} />
          Edit
        </button>
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-[11px] font-medium transition-colors disabled:opacity-40"
        >
          <RotateCw size={11} className={retrying ? 'animate-spin' : ''} />
          Retry
        </button>
        <button
          onClick={handleDelete}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-red-900/40 text-zinc-400 hover:text-red-400 text-[11px] font-medium transition-colors"
        >
          <Trash2 size={11} />
          Delete
        </button>
      </div>

      {/* Description */}
      <div className="px-4 pb-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">Description</div>
        <p className="text-xs text-zinc-300 leading-relaxed">{placement.description}</p>
      </div>

      {/* Style */}
      {placement.style && Object.keys(placement.style).length > 0 && (
        <div className="px-4 pb-3">
          <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1.5">Style</div>
          <div className="flex flex-wrap gap-1">
            {Object.entries(placement.style).map(([k, v]) => v ? (
              <span key={k} className="px-2 py-1 rounded bg-zinc-800/80 text-[10px] text-zinc-400">
                <span className="text-zinc-500">{k}:</span> {v}
              </span>
            ) : null)}
          </div>
        </div>
      )}

      {/* Other options */}
      {placement.results?.length > 0 && (
        <div className="px-4 pb-4 border-t border-white/5 pt-3">
          <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-2">
            Other Options ({placement.results.length})
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {placement.results.map((r, i) => {
              const thumb = r.thumbnail_url || r.preview_url || r.url
              return (
                <button
                  key={r.id || i}
                  onClick={() => selectResult(selectedIndex, i)}
                  className={`relative rounded overflow-hidden aspect-video transition-all ${
                    i === resultIdx
                      ? 'ring-2 ring-teal-400 scale-[1.02]'
                      : 'ring-1 ring-white/10 hover:ring-white/25 opacity-70 hover:opacity-100'
                  }`}
                >
                  {thumb ? (
                    <img src={thumb} alt={r.title || ''} className="w-full h-full object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-full bg-zinc-800 flex items-center justify-center text-zinc-600 text-[9px]">No thumb</div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1 py-0.5 flex items-center gap-1">
                    <span className="text-[8px] text-white/70 capitalize">{r.source}</span>
                    {r.duration > 0 && <span className="text-[8px] text-white/50">{r.duration}s</span>}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Edit modal */}
      {showEditModal && (
        <EditModal
          placement={placement}
          index={selectedIndex}
          onSearch={(overrides) => { setShowEditModal(false); broll.searchPlacementCustom(selectedIndex, overrides) }}
          onClose={() => setShowEditModal(false)}
        />
      )}
    </div>
  )
}

function EditModal({ placement, index, onSearch, onClose }) {
  const [description, setDescription] = useState(placement.description || '')
  const [colors, setColors] = useState(placement.style?.colors || '')
  const [temperature, setTemperature] = useState(placement.style?.temperature || '')
  const [motion, setMotion] = useState(placement.style?.motion || '')
  const [sources, setSources] = useState(['pexels', 'storyblocks'])

  function toggleSource(src) {
    setSources(prev => {
      if (prev.includes(src)) {
        const next = prev.filter(s => s !== src)
        return next.length ? next : prev
      }
      return [...prev, src]
    })
  }

  function handleSearch() {
    const parts = []
    if (colors.trim()) parts.push(`colors: ${colors.trim()}`)
    if (temperature.trim()) parts.push(`temperature: ${temperature.trim()}`)
    if (motion.trim()) parts.push(`motion: ${motion.trim()}`)
    onSearch({ description, style: parts.join('; '), sources })
  }

  const inputCls = "w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-xs text-zinc-200 outline-none focus:border-teal-600/50"

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm px-6" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-white/10 bg-[#1a1a1c] shadow-2xl shadow-black/60"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <span className="text-sm font-semibold text-zinc-200">Edit Search</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300">
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Description */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5 block">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              className={`${inputCls} resize-none`}
            />
          </div>

          {/* Style — separate fields */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5 block">Style</label>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-500 w-20 shrink-0">Colors</span>
                <input value={colors} onChange={e => setColors(e.target.value)} placeholder="warm browns, earth tones" className={inputCls} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-500 w-20 shrink-0">Temperature</span>
                <input value={temperature} onChange={e => setTemperature(e.target.value)} placeholder="warm, golden" className={inputCls} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-500 w-20 shrink-0">Motion</span>
                <input value={motion} onChange={e => setMotion(e.target.value)} placeholder="slow pan, static" className={inputCls} />
              </div>
            </div>
          </div>

          {/* Source */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1.5 block">Source</label>
            <div className="flex gap-2">
              {['pexels', 'storyblocks'].map(src => (
                <button
                  key={src}
                  onClick={() => toggleSource(src)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    sources.includes(src)
                      ? 'bg-teal-600/20 text-teal-400 border border-teal-600/40'
                      : 'bg-zinc-800 text-zinc-500 border border-white/5 hover:text-zinc-300'
                  }`}
                >
                  {src.charAt(0).toUpperCase() + src.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/5 flex justify-end">
          <button
            onClick={handleSearch}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium bg-teal-600 hover:bg-teal-500 text-white transition-colors"
          >
            <Search size={14} />
            Search
          </button>
        </div>
      </div>
    </div>
  )
}

function VideoPreview({ url, thumbnail }) {
  const videoRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const videoSrc = url || ''
  const hasSrc = videoSrc.length > 0

  function togglePlay() {
    if (!hasSrc || !videoRef.current) return
    if (videoRef.current.paused) {
      videoRef.current.play()
      setPlaying(true)
    } else {
      videoRef.current.pause()
      setPlaying(false)
    }
  }

  if (!hasSrc && thumbnail) {
    return (
      <div className="rounded-lg overflow-hidden bg-black">
        <img src={thumbnail} alt="" className="w-full aspect-video object-cover" />
      </div>
    )
  }

  return (
    <div className="relative group cursor-pointer rounded-lg overflow-hidden" onClick={togglePlay}>
      <video
        ref={videoRef}
        src={videoSrc}
        poster={thumbnail}
        className="w-full aspect-video object-cover bg-black"
        preload="metadata"
        playsInline
        muted
        onEnded={() => setPlaying(false)}
      />
      <div className={`absolute inset-0 flex items-center justify-center transition-opacity ${playing ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'}`}>
        <div className="w-9 h-9 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center">
          {playing ? <Pause size={16} className="text-white" /> : <Play size={16} className="text-white ml-0.5" />}
        </div>
      </div>
    </div>
  )
}

function SearchPrompt({ placement, index, searchPlacement }) {
  const isSearching = placement.searchStatus === 'searching'
  const isFailed = placement.searchStatus === 'failed'
  const noResults = placement.searchStatus === 'no_results'

  return (
    <div className="rounded-lg aspect-video bg-zinc-800/50 border border-white/5 flex flex-col items-center justify-center gap-3 px-4">
      {isSearching ? (
        <>
          <Loader2 size={24} className="text-teal-400 animate-spin" />
          <span className="text-xs text-teal-400">Searching stock footage...</span>
        </>
      ) : (
        <>
          {isFailed && <span className="text-xs text-red-400">Search failed</span>}
          {noResults && <span className="text-xs text-zinc-500">No results found</span>}
          {!isFailed && !noResults && <span className="text-xs text-zinc-500">Not searched yet</span>}
          <button
            onClick={() => searchPlacement(index)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-teal-600 hover:bg-teal-500 text-white transition-colors"
          >
            <Search size={14} />
            {isFailed || noResults ? 'Retry Search' : 'Search'}
          </button>
        </>
      )}
    </div>
  )
}
