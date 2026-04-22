import { useState, useRef, useEffect } from 'react'
import { useApi, apiPost, apiPut, apiDelete } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

const MAX_REFERENCES = 3

function ytThumbnail(url) {
  if (!url) return null
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/)
  return m ? `https://img.youtube.com/vi/${m[1]}/mqdefault.jpg` : null
}

function StatusBadge({ status }) {
  if (status === 'ready') return <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#cefc00]/10 text-[#cefc00] uppercase font-bold">Ready</span>
  if (status === 'processing') return <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#c180ff]/10 text-[#c180ff] uppercase font-bold animate-pulse">Downloading</span>
  if (status === 'failed') return <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 uppercase font-bold">Failed</span>
  return <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-[#acaaad] uppercase font-bold">Pending</span>
}

export default function BRollExamplesModal({ groupId, onBack, onComplete }) {
  const { data: sources, loading, error: fetchError, refetch } = useApi(`/broll/groups/${groupId}/examples`)
  const [videoUrls, setVideoUrls] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef(null)

  const items = sources || []
  const atLimit = items.length >= MAX_REFERENCES
  const hasFavorite = items.some(s => s.is_favorite)
  const hasSources = items.length > 0
  const needsMore = items.length < 2
  const hasProcessing = items.some(s => s.status === 'pending' || s.status === 'processing')

  // Poll for status updates while any source is still processing
  useEffect(() => {
    if (!hasProcessing) return
    const interval = setInterval(refetch, 3000)
    return () => clearInterval(interval)
  }, [hasProcessing, refetch])

  async function handleAddVideos(e) {
    e?.preventDefault()
    const urls = videoUrls.split(',').map(u => u.trim()).filter(Boolean)
    if (!urls.length) return
    setSubmitting(true)
    try {
      let added = 0
      for (const u of urls) {
        if (items.length + added >= MAX_REFERENCES) break
        await apiPost(`/broll/groups/${groupId}/examples`, {
          kind: 'yt_video',
          source_url: u,
        })
        added++
      }
      setVideoUrls('')
      refetch()
    } catch (err) {
      alert(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleFileUpload(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setSubmitting(true)
    try {
      for (const file of files) {
        if (items.length >= MAX_REFERENCES) break
        const form = new FormData()
        form.append('file', file)
        form.append('label', file.name.replace(/\.[^/.]+$/, ''))
        const headers = {}
        if (supabase) {
          const { data } = await supabase.auth.getSession()
          if (data.session?.access_token) headers['Authorization'] = `Bearer ${data.session.access_token}`
        }
        const res = await fetch(`${API_BASE}/broll/groups/${groupId}/examples/upload`, {
          method: 'POST',
          headers,
          body: form,
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }))
          throw new Error(err.error || 'Upload failed')
        }
      }
      refetch()
    } catch (err) {
      alert(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id) {
    await apiDelete(`/broll/examples/${id}`)
    refetch()
  }

  async function handleSetFavorite(id) {
    await apiPut(`/broll/examples/${id}/favorite`)
    refetch()
  }

  // Slots for the video grid
  const slots = []
  for (let i = 0; i < MAX_REFERENCES; i++) {
    slots.push(items[i] || null)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      {/* Modal Window — matches other modals */}
      <div className="bg-[#131315] w-full max-w-[900px] max-h-[90vh] rounded-xl shadow-[0_24px_48px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden relative border border-white/[0.06]">

        {/* Scroll Area */}
        <div className="flex-1 overflow-y-auto p-8">

          {/* Header */}
          <header className="mb-8">
            <div className="flex items-center gap-2 text-[#c180ff] mb-3">
              <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>auto_awesome</span>
              <span className="text-[10px] font-bold uppercase tracking-[0.2em]">Reference Videos</span>
            </div>
            <h1 className="text-3xl font-extrabold font-['Manrope'] tracking-tight text-[#f6f3f5]">
              AI Context: <span className="text-[#cefc00]">Add Reference Videos</span>
            </h1>
            <p className="mt-3 text-[#acaaad] max-w-2xl leading-relaxed text-sm">
              Feed the AI with references. These examples will calibrate the AI's understanding of your b-roll selection, pacing, and transition style.
            </p>
          </header>

          {fetchError && (
            <div className="mb-5 flex items-center justify-between gap-3 bg-red-500/5 border border-red-500/30 rounded-lg px-5 py-3">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-red-400 text-lg">error</span>
                <span className="text-xs text-red-400/90">Couldn't load references: {fetchError}. Any examples you just added may already be saved.</span>
              </div>
              <button
                onClick={() => refetch()}
                className="px-3 py-1.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 text-[10px] font-bold uppercase tracking-widest transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {/* YouTube Videos Section */}
          <div className="bg-[#0e0e10] p-6 rounded-xl border border-[#48474a]/10">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg bg-[#262528] flex items-center justify-center text-[#c180ff]">
                <span className="material-symbols-outlined text-xl">smart_display</span>
              </div>
              <h3 className="font-bold text-base font-['Manrope']">YouTube Videos</h3>
            </div>
            <form onSubmit={handleAddVideos} className="flex gap-2 mb-6">
              <div className="flex-1 relative">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[#acaaad] text-sm">link</span>
                <input
                  className="w-full bg-[#262528] border-none rounded-lg py-3 pl-10 pr-4 text-sm focus:ring-1 focus:ring-[#cefc00] text-[#f6f3f5] placeholder:text-[#acaaad]/30 outline-none"
                  placeholder="Enter video URLs separated by commas..."
                  type="text"
                  value={videoUrls}
                  onChange={(e) => setVideoUrls(e.target.value)}
                  disabled={atLimit || submitting}
                />
              </div>
              <button
                type="submit"
                disabled={submitting || !videoUrls.trim() || atLimit}
                className="px-6 bg-[#262528] hover:bg-[#2c2c2f] transition-colors rounded-lg font-bold text-sm text-[#f6f3f5] disabled:opacity-40"
              >
                {submitting ? 'Adding...' : 'Fetch'}
              </button>
            </form>

            {/* Video slots grid */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {slots.map((source, i) => source ? (
                <div key={source.id} className={`bg-[#131315] rounded-lg p-3 flex flex-col gap-2 ${source.is_favorite ? 'border-2 border-[#cefc00]/40' : 'border border-[#48474a]/10'}`}>
                  <div className="aspect-video bg-[#262528] rounded-md overflow-hidden relative group">
                    {(() => {
                      const thumb = ytThumbnail(source.source_url) || (source.meta_json && JSON.parse(source.meta_json || '{}').thumbnailUrl)
                      return thumb
                        ? <img src={thumb} alt="" className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center">
                            <span className="material-symbols-outlined text-[#acaaad]/30 text-3xl">smart_display</span>
                          </div>
                    })()}
                    {/* Play — opens YouTube */}
                    <a
                      href={source.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="absolute inset-0 flex items-center justify-center bg-[#0e0e10]/40"
                    >
                      <span className="material-symbols-outlined text-[#cefc00] text-3xl drop-shadow-lg">play_circle</span>
                    </a>
                    {/* Favorite star */}
                    <button
                      onClick={() => handleSetFavorite(source.id)}
                      className={`absolute top-1.5 right-1.5 p-1 rounded transition-colors ${source.is_favorite ? 'text-[#cefc00]' : 'text-white/50 hover:text-[#cefc00]'}`}
                      title={source.is_favorite ? 'Favorite (main plan)' : 'Set as favorite'}
                    >
                      <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: source.is_favorite ? '"FILL" 1' : '"FILL" 0' }}>star</span>
                    </button>
                    {/* Delete */}
                    <button
                      onClick={() => handleDelete(source.id)}
                      className="absolute top-1.5 left-1.5 p-1 rounded text-white/50 hover:text-red-400 transition-all"
                    >
                      <span className="material-symbols-outlined text-base">close</span>
                    </button>
                  </div>
                  <div className="flex justify-between items-start gap-2">
                    <span className="text-[10px] font-medium text-[#acaaad] truncate flex-1">
                      {source.label || source.source_url || `Video #${source.id}`}
                    </span>
                    <StatusBadge status={source.status} />
                  </div>
                  {source.error && (
                    <span className="text-[9px] text-red-400 truncate">{source.error}</span>
                  )}
                </div>
              ) : (
                <div key={`empty-${i}`} className="bg-[#131315] rounded-lg p-3 border-2 border-dashed border-[#48474a]/10 flex items-center justify-center aspect-[16/12]">
                  <span className="text-[#acaaad]/20 material-symbols-outlined text-3xl">add</span>
                </div>
              ))}
            </div>
          </div>

          {/* Local Reference Files */}
          <div
            className="mt-6 bg-[#0e0e10] p-6 rounded-xl border border-[#48474a]/10 group cursor-pointer transition-all hover:border-[#cefc00]/30"
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="flex flex-col items-center justify-center text-center py-8 border-2 border-dashed border-[#48474a]/20 rounded-xl group-hover:bg-[#cefc00]/5 transition-colors">
              <div className="w-12 h-12 rounded-full bg-[#262528] flex items-center justify-center mb-3 transition-transform group-hover:-translate-y-1">
                <span className="material-symbols-outlined text-2xl text-[#cefc00]">upload_file</span>
              </div>
              <h3 className="text-base font-bold font-['Manrope'] mb-1">Local Reference Files</h3>
              <p className="text-[#acaaad] text-xs max-w-sm">
                Drag and drop <span className="text-[#f6f3f5] font-mono">.mp4</span> or <span className="text-[#f6f3f5] font-mono">.mov</span> files here
              </p>
              <div className="mt-4 flex gap-3">
                <span className="px-2.5 py-1 rounded bg-[#262528] text-[10px] font-bold uppercase text-[#acaaad]">H.264 / HEVC</span>
                <span className="px-2.5 py-1 rounded bg-[#262528] text-[10px] font-bold uppercase text-[#acaaad]">Max 2GB per file</span>
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept=".mp4,.mov" multiple className="hidden" onChange={handleFileUpload} />
          </div>

          {/* Minimum references warning */}
          {hasSources && needsMore && (
            <div className="mt-5 flex items-center gap-3 bg-[#c180ff]/5 border border-[#c180ff]/20 rounded-lg px-5 py-3">
              <span className="material-symbols-outlined text-[#c180ff] text-lg">add_circle</span>
              <span className="text-xs text-[#c180ff]/80">Add at least 2 reference videos — the AI needs multiple examples to learn your b-roll style.</span>
            </div>
          )}

          {/* Favorite warning */}
          {hasSources && !needsMore && !hasFavorite && (
            <div className="mt-5 flex items-center gap-3 bg-[#cefc00]/5 border border-[#cefc00]/20 rounded-lg px-5 py-3">
              <span className="material-symbols-outlined text-[#cefc00] text-lg">star</span>
              <span className="text-xs text-[#cefc00]/80">Pick a favorite reference — it will drive the main B-Roll plan. Hover over a video and click the star.</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="bg-[#0e0e10] border-t border-white/5 px-8 py-5 flex items-center justify-between shrink-0">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-[#acaaad] font-bold text-xs uppercase tracking-widest hover:text-[#f6f3f5] transition-colors"
          >
            <span className="material-symbols-outlined text-sm">arrow_back</span>
            Back
          </button>
          <div className="flex items-center gap-6">
            <div className="hidden sm:flex flex-col items-end">
              <span className="text-[10px] uppercase font-bold text-[#cefc00] tracking-tighter">Max Examples: {MAX_REFERENCES}</span>
              <span className="text-xs text-[#acaaad]">Current: {items.length}/{MAX_REFERENCES}</span>
            </div>
            <button
              onClick={() => onComplete(groupId)}
              disabled={hasSources && (needsMore || !hasFavorite)}
              className="px-8 py-3 bg-[#cefc00] text-[#0e0e10] font-black uppercase tracking-tighter text-sm rounded shadow-[0_0_32px_rgba(206,252,0,0.2)] active:scale-95 transition-all hover:shadow-[0_0_48px_rgba(206,252,0,0.4)] disabled:opacity-40 disabled:shadow-none"
            >
              {hasSources ? (needsMore ? `Add ${2 - items.length} More` : hasFavorite ? 'Continue' : 'Pick a Favorite') : 'Skip'}
            </button>
          </div>
        </footer>

        {/* Close Button */}
        <button onClick={onBack} className="absolute top-6 right-6 text-[#acaaad] hover:text-[#f6f3f5] transition-colors">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
    </div>
  )
}
