// src/components/upload-config/steps/StepReferences.jsx
import { useEffect, useRef, useState } from 'react'
import { useApi, apiPost, apiPut, apiDelete } from '../../../hooks/useApi.js'
import { supabase } from '../../../lib/supabaseClient.js'
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
const MAX_REFERENCES = 3

function ytThumbnail(url) {
  if (!url) return null
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/)
  return m ? `https://img.youtube.com/vi/${m[1]}/mqdefault.jpg` : null
}

function StatusBadge({ status }) {
  const styles = {
    ready:      { bg: 'bg-lime/12',          fg: 'text-lime',          label: 'Ready',       pulse: false },
    processing: { bg: 'bg-purple-accent/12', fg: 'text-purple-accent', label: 'Downloading', pulse: true },
    failed:     { bg: 'bg-red-500/12',       fg: 'text-red-400',       label: 'Failed',      pulse: false },
    pending:    { bg: 'bg-white/4',          fg: 'text-on-surface-variant', label: 'Pending', pulse: false },
  }
  const s = styles[status] || styles.pending
  return (
    <span className={[
      'text-[9px] px-[7px] py-[3px] rounded uppercase font-extrabold tracking-[0.12em] font-["Inter"] shrink-0',
      s.bg, s.fg, s.pulse ? 'animate-pulse' : '',
    ].join(' ')}>
      {s.label}
    </span>
  )
}

function RefCard({ item, onRemove, onFavorite }) {
  const [hover, setHover] = useState(false)
  const thumb = ytThumbnail(item.source_url) || (item.meta_json && JSON.parse(item.meta_json || '{}').thumbnailUrl)

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'bg-surface-container-low rounded-[10px] p-2.5 flex flex-col gap-2 transition-all',
        item.is_favorite
          ? 'ring-[1.5px] ring-inset ring-lime/50 shadow-[0_0_20px_rgba(206,252,0,0.1)]'
          : 'ring-1 ring-inset ring-border-subtle/15',
      ].join(' ')}
    >
      <div className="aspect-video bg-surface-container-high rounded-md overflow-hidden relative">
        {thumb
          ? <img src={thumb} alt="" className="w-full h-full object-cover" />
          : (
            <div className="w-full h-full flex items-center justify-center text-on-surface-variant/30">
              <span className="material-symbols-outlined text-[32px]">
                {item.kind === 'upload' ? 'movie' : 'smart_display'}
              </span>
            </div>
          )}
        <a
          href={item.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute inset-0 flex items-center justify-center bg-black/35"
          onClick={e => e.stopPropagation()}
        >
          <span className="material-symbols-outlined text-[36px] text-lime drop-shadow-lg">play_circle</span>
        </a>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onFavorite() }}
          title={item.is_favorite ? 'Favorite (main plan)' : 'Set as favorite'}
          className={[
            'absolute top-1.5 right-1.5 w-6 h-6 rounded border-none bg-black/60 flex items-center justify-center cursor-pointer transition-colors',
            item.is_favorite ? 'text-lime' : 'text-white/60 hover:text-lime',
          ].join(' ')}
        >
          <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: `"FILL" ${item.is_favorite ? 1 : 0}` }}>
            star
          </span>
        </button>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onRemove() }}
          className={[
            'absolute top-1.5 left-1.5 w-6 h-6 rounded border-none bg-black/60 flex items-center justify-center cursor-pointer transition-colors',
            hover ? 'text-red-400' : 'text-white/60',
          ].join(' ')}
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      </div>
      <div className="flex justify-between items-center gap-2">
        <span className="text-[10px] text-on-surface-variant font-['Inter'] truncate flex-1 font-medium">
          {item.label || item.source_url || `Video #${item.id}`}
        </span>
        <StatusBadge status={item.status} />
      </div>
    </div>
  )
}

function EmptySlot() {
  return (
    <div className="bg-surface-container-low rounded-[10px] p-2.5 border-2 border-dashed border-border-subtle/25 flex items-center justify-center aspect-[16/12]">
      <span className="material-symbols-outlined text-[32px] text-on-surface-variant/25">add</span>
    </div>
  )
}

export default function StepReferences({ groupId, onValidityChange }) {
  const { data: items, refetch, mutate } = useApi(`/broll/groups/${groupId}/examples`)
  const [videoUrls, setVideoUrls] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef(null)

  const list = items || []
  const atLimit = list.length >= MAX_REFERENCES
  const hasSources = list.length > 0
  const needsMore = list.length < 2
  const hasFavorite = list.some(s => s.is_favorite)
  const hasProcessing = list.some(s => s.status === 'pending' || s.status === 'processing')

  useEffect(() => {
    if (!hasProcessing) return
    const interval = setInterval(refetch, 3000)
    return () => clearInterval(interval)
  }, [hasProcessing, refetch])

  useEffect(() => {
    onValidityChange?.(!needsMore && hasFavorite)
  }, [needsMore, hasFavorite, onValidityChange])

  async function handleAddVideos(e) {
    e?.preventDefault()
    const urls = videoUrls.split(',').map(u => u.trim()).filter(Boolean)
    if (!urls.length) return
    setSubmitting(true)
    try {
      let addedCount = 0
      for (const u of urls) {
        if (list.length + addedCount >= MAX_REFERENCES) break
        const added = await apiPost(`/broll/groups/${groupId}/examples`, {
          kind: 'yt_video',
          source_url: u,
        })
        mutate(prev => [added, ...(prev || []).filter(s => s.id !== added.id)])
        addedCount++
      }
      setVideoUrls('')
      refetch(true)
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
        if (list.length >= MAX_REFERENCES) break
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
        const added = await res.json()
        mutate(prev => [added, ...(prev || []).filter(s => s.id !== added.id)])
      }
      refetch(true)
    } catch (err) {
      alert(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async id => { await apiDelete(`/broll/examples/${id}`); refetch() }
  const setFavorite = async id => { await apiPut(`/broll/examples/${id}/favorite`); refetch() }

  const slots = []
  for (let i = 0; i < MAX_REFERENCES; i++) slots.push(list[i] || null)

  return (
    <div>
      <div className="mb-7">
        <Eyebrow icon="auto_awesome" tone="secondary">Reference Videos · Step 4 of 6</Eyebrow>
        <div className="mt-3.5">
          <PageTitle line1="AI Context:" line2="Add Reference Videos" accentTone="primary" size={26} />
        </div>
        <p className="mt-3 text-on-surface-variant text-[13px] max-w-[680px] leading-[1.6]">
          Feed the AI with references. These examples will calibrate the AI's understanding of your b-roll selection,
          pacing, and transition style.
        </p>
      </div>

      <div className="bg-black p-6 rounded-xl ring-1 ring-inset ring-border-subtle/10 mb-5">
        <div className="flex items-center gap-3 mb-[18px]">
          <div className="w-9 h-9 rounded-lg bg-surface-container-high text-purple-accent flex items-center justify-center">
            <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: '"FILL" 1' }}>smart_display</span>
          </div>
          <div className="text-[15px] font-bold text-on-surface font-['Inter']">YouTube Videos</div>
        </div>

        <form onSubmit={handleAddVideos} className="flex gap-2 mb-5">
          <div className="flex-1 relative">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[16px] text-muted">link</span>
            <input
              type="text"
              value={videoUrls}
              onChange={e => setVideoUrls(e.target.value)}
              placeholder="Enter video URLs separated by commas…"
              disabled={atLimit || submitting}
              className="w-full bg-surface-container-high text-on-surface ring-1 ring-inset ring-border-subtle/15 rounded-lg py-3 pl-10 pr-4 text-[13px] font-['Inter'] outline-none disabled:opacity-50 focus:ring-lime/30 box-border"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !videoUrls.trim() || atLimit}
            className="px-6 bg-surface-container-high text-on-surface rounded-lg text-xs font-bold font-['Inter'] uppercase tracking-[0.15em] disabled:opacity-40 hover:bg-surface-container-highest transition-colors"
          >
            {submitting ? 'Adding…' : 'Fetch'}
          </button>
        </form>

        <div className="grid grid-cols-3 gap-3.5">
          {slots.map((item, i) => item
            ? <RefCard key={item.id} item={item} onRemove={() => remove(item.id)} onFavorite={() => setFavorite(item.id)} />
            : <EmptySlot key={`empty-${i}`} />
          )}
        </div>
      </div>

      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); handleFileUpload({ target: { files: e.dataTransfer.files, value: '' } }) }}
        className="bg-black p-6 rounded-xl cursor-pointer ring-1 ring-inset ring-border-subtle/10 hover:ring-lime/30 transition-all"
      >
        <div className="border-2 border-dashed border-border-subtle/25 rounded-[10px] py-7 px-5 text-center">
          <div className="w-12 h-12 rounded-full mx-auto mb-3 bg-surface-container-high text-lime flex items-center justify-center">
            <span className="material-symbols-outlined text-[22px]">upload_file</span>
          </div>
          <div className="text-sm font-bold text-on-surface font-['Inter'] mb-1">Local Reference Files</div>
          <div className="text-xs text-on-surface-variant font-['Inter']">
            Drag and drop <span className="text-on-surface font-mono">.mp4</span> or{' '}
            <span className="text-on-surface font-mono">.mov</span> files here
          </div>
          <div className="mt-3.5 flex gap-2 justify-center">
            <span className="px-2.5 py-1 rounded bg-surface-container-high text-[10px] font-bold uppercase text-on-surface-variant font-['Inter']">H.264 / HEVC</span>
            <span className="px-2.5 py-1 rounded bg-surface-container-high text-[10px] font-bold uppercase text-on-surface-variant font-['Inter']">Max 2GB per file</span>
          </div>
        </div>
        <input ref={fileRef} type="file" accept=".mp4,.mov" multiple className="hidden" onChange={handleFileUpload} />
      </div>

      {hasSources && needsMore && (
        <div className="mt-4 flex items-center gap-3 px-[18px] py-3 rounded-[10px] bg-purple-accent/5 ring-1 ring-inset ring-purple-accent/25">
          <span className="material-symbols-outlined text-[18px] text-purple-accent">add_circle</span>
          <span className="text-xs text-purple-accent/80 font-['Inter'] leading-[1.5]">
            Add at least 2 reference videos — the AI needs multiple examples to learn your b-roll style.
          </span>
        </div>
      )}
      {hasSources && !needsMore && !hasFavorite && (
        <div className="mt-4 flex items-center gap-3 px-[18px] py-3 rounded-[10px] bg-lime/5 ring-1 ring-inset ring-lime/25">
          <span className="material-symbols-outlined text-[18px] text-lime" style={{ fontVariationSettings: '"FILL" 1' }}>star</span>
          <span className="text-xs text-on-surface font-['Inter'] leading-[1.5]">
            Pick a favorite reference — it will drive the main B-Roll plan. Hover a video and click the star.
          </span>
        </div>
      )}

      <div className="mt-[18px] px-4 py-3 rounded-lg bg-surface-container-low ring-1 ring-inset ring-border-subtle/8 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="material-symbols-outlined text-[16px] text-lime">movie</span>
          <span className="text-[11px] text-on-surface-variant font-['Inter']">
            <span className="text-on-surface font-bold">{list.length}</span> / {MAX_REFERENCES} references added
          </span>
        </div>
        <span className="text-[10px] font-bold text-lime uppercase tracking-[0.2em] font-['Inter']">
          Max Examples: {MAX_REFERENCES}
        </span>
      </div>
    </div>
  )
}
