import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Loader2, RotateCcw } from 'lucide-react'
import { apiPost } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'
import * as tus from 'tus-js-client'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mxf', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.ts', '.mts']
const AUDIO_EXTS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma']
const VIDEO_ACCEPT = [...VIDEO_EXTS, ...AUDIO_EXTS].join(',')
const MAX_SIZE = 50 * 1024 * 1024 * 1024 // 50GB

// Probe a video file's duration + pixel dimensions locally before upload
// starts. Reads only the moov atom via an HTML5 <video> element + blob URL
// — no bytes are uploaded, no extra deps. Returns
// `{ duration, width, height }` (width/height are null for audio-only
// containers), or null when the browser can't decode at all (rare
// formats, corrupted files, or live-style MSE streams that report
// Infinity until seek).
//
// Used by validateAndAddFiles to attach durationSeconds + width/height
// to each file entry; the values are forwarded to /videos/register so
// (a) the rough-cut estimator can run from t≈0 and (b) the b-roll
// search has an `orientation` hint immediately.
//
// The optional opts arg lets unit tests inject mock factories — see
// __tests__/UploadModal-probe-duration.test.js. Production callers omit
// opts and use the default DOM factories.
export function probeDuration(file, opts = {}) {
  const _createElement = opts._createElement || ((tag) => document.createElement(tag))
  const _createObjectURL = opts._createObjectURL || ((f) => URL.createObjectURL(f))
  const _revokeObjectURL = opts._revokeObjectURL || ((u) => URL.revokeObjectURL(u))

  const tryWith = (tag) => new Promise((res) => {
    const url = _createObjectURL(file)
    const el = _createElement(tag)
    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      const dur = el.duration
      // videoWidth/videoHeight only exist on HTMLVideoElement — for the
      // <audio> fallback they're undefined, which we collapse to null so
      // bucketAspect's audio path picks the landscape default.
      const w = el.videoWidth || null
      const h = el.videoHeight || null
      _revokeObjectURL(url)
      res(Number.isFinite(dur) && dur > 0 ? { duration: dur, width: w, height: h } : null)
    }
    el.onerror = () => {
      _revokeObjectURL(url)
      res(null)
    }
    el.src = url
  })

  return tryWith('video').then((r) => {
    if (r != null) return r
    // fallback for audio-only containers that <video> can't decode
    return tryWith('audio')
  })
}

export default function UploadModal({ onClose, onComplete, initialGroupId, onFilesChange }) {
  const [files, _setFiles] = useState([])
  const setFiles = useCallback((updater) => {
    _setFiles(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      onFilesChange?.(next)
      return next
    })
  }, [onFilesChange])
  const [groupId, setGroupId] = useState(initialGroupId || null)
  const [videoUrl, setVideoUrl] = useState('')
  const [groupError, setGroupError] = useState(null)
  const groupIdRef = useRef(initialGroupId || null)
  const groupPromiseRef = useRef(null)
  const videoInputRef = useRef(null)

  useEffect(() => { groupIdRef.current = groupId }, [groupId])

  const hasFiles = files.length > 0
  const hasUploading = files.some(f => f.status === 'uploading')

  // Escape key
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && !hasUploading) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [hasUploading, onClose])

  const ensureGroup = useCallback(async () => {
    if (groupIdRef.current) return groupIdRef.current
    // Reuse pending promise so concurrent calls share one group creation
    if (groupPromiseRef.current) return groupPromiseRef.current
    groupPromiseRef.current = (async () => {
      try {
        setGroupError(null)
        const name = `Project ${new Date().toLocaleDateString()}`
        const res = await apiPost('/videos/groups', { name })
        const id = res.id
        setGroupId(id)
        groupIdRef.current = id
        return id
      } catch (err) {
        console.error('[upload] Group creation failed:', err)
        groupPromiseRef.current = null
        setGroupError(`Failed to create project: ${err.message}`)
        throw err
      }
    })()
    return groupPromiseRef.current
  }, [])

  const uploadFileWithProgress = useCallback(async (entry, gid) => {
    try {
      console.log(`[upload] uploadFileWithProgress called for ${entry.name}, gid=${gid}`)
      const entryId = entry.id
      const ext = '.' + entry.file.name.split('.').pop().toLowerCase()
      const isAudio = AUDIO_EXTS.includes(ext) || (entry.file.type || '').startsWith('audio/')

      // Audio files cannot use Cloudflare Stream (video-only transcoding).
      // Route audio through multer → Supabase via POST /videos/upload,
      // mirroring ProcessingModal's add-files XHR pattern.
      if (isAudio) {
        await new Promise(async (resolve, reject) => {
          const formData = new FormData()
          formData.append('video', entry.file)
          formData.append('title', entry.name)
          formData.append('group_id', gid)
          formData.append('video_type', 'raw')

          const API_BASE = import.meta.env.VITE_API_URL || '/api'
          const xhr = new XMLHttpRequest()
          xhr.open('POST', `${API_BASE}/videos/upload`)

          // Match TUS path: send Supabase auth token if available
          if (supabase) {
            const { data: { session } } = await supabase.auth.getSession()
            if (session?.access_token) {
              xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`)
            }
          }

          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return
            const pct = Math.round((e.loaded / e.total) * 100)
            setFiles(prev => prev.map(f => f.id === entryId
              ? { ...f, progress: pct, loaded: e.loaded, total: e.total }
              : f))
          }
          xhr.onload = () => {
            try {
              const data = JSON.parse(xhr.responseText)
              if (xhr.status >= 200 && xhr.status < 300) {
                setFiles(prev => prev.map(f => f.id === entryId
                  ? { ...f, status: 'complete', progress: 100, serverId: data.videoId }
                  : f))
                resolve()
              } else {
                reject(new Error(data.error || 'Upload failed'))
              }
            } catch {
              reject(new Error('Upload failed'))
            }
          }
          xhr.onerror = () => reject(new Error('Network error'))
          xhr.timeout = 3600000
          xhr.send(formData)
        })
        return
      }

      // 1. Upload via TUS to backend proxy → Cloudflare Stream
      // Backend proxies the TUS creation POST to CF, returns Location header.
      // tus-js-client then PATCHes directly to CF. This is the CF-recommended approach.
      let cfStreamUid = null
      const API_BASE = import.meta.env.VITE_API_URL || '/api'

      await new Promise((resolve, reject) => {
        const backendOrigin = API_BASE.startsWith('http') ? new URL(API_BASE).origin : window.location.origin
        const upload = new tus.Upload(entry.file, {
          endpoint: `${API_BASE}/videos/stream/tus-create`,
          chunkSize: 50 * 1024 * 1024, // 50MB — CF recommended
          retryDelays: [0, 3000, 5000, 10000, 20000],
          removeFingerprintOnSuccess: true,
          storeFingerprintForResuming: false,
          metadata: { name: entry.file.name, filetype: entry.file.type || 'video/mp4' },
          onBeforeRequest: async (req) => {
            // Fetch fresh token per-request so it never expires mid-upload
            // Only send auth to our backend, not to Cloudflare
            const url = req.getURL ? req.getURL() : req._url || ''
            const isOurBackend = url.startsWith('/') || url.startsWith(backendOrigin)
            if (supabase && isOurBackend) {
              const { data: { session } } = await supabase.auth.getSession()
              if (session?.access_token) {
                req.setHeader('Authorization', `Bearer ${session.access_token}`)
              }
            }
          },
          onError: (err) => reject(new Error(err.message || 'Upload failed')),
          onProgress: (bytesUploaded, bytesTotal) => {
            const pct = Math.round((bytesUploaded / bytesTotal) * 100)
            console.log(`[upload] ${entry.name}: ${pct}% (${(bytesUploaded/1024/1024).toFixed(1)}/${(bytesTotal/1024/1024).toFixed(1)} MB)`)
            setFiles(prev => prev.map(f => f.id === entryId ? { ...f, progress: pct, loaded: bytesUploaded, total: bytesTotal } : f))
          },
          onAfterResponse: (req, res) => {
            const mediaId = res.getHeader('Stream-Media-Id')
            if (mediaId) cfStreamUid = mediaId
          },
          onSuccess: () => resolve(),
        })
        upload.start()
      })

      if (!cfStreamUid) throw new Error('Upload completed but no Stream-Media-Id received')
      console.log(`[upload] Cloudflare Stream upload complete: ${cfStreamUid}`)

      // 3. Register with backend (Cloudflare only — no Supabase URL)
      setFiles(prev => prev.map(f => f.id === entry.id ? { ...f, progress: 100 } : f))

      const result = await apiPost('/videos/register', {
        filename: entry.file.name,
        title: entry.name,
        group_id: gid,
        video_type: 'raw',
        file_size: entry.file.size,
        cf_stream_uid: cfStreamUid,
        duration_seconds: entry.durationSeconds ?? null,
        width: entry.width ?? null,
        height: entry.height ?? null,
      })

      setFiles(prev => prev.map(f =>
        f.id === entry.id ? { ...f, status: 'complete', progress: 100, serverId: result.videoId } : f
      ))
    } catch (err) {
      console.error('[upload] Upload failed:', err)
      setFiles(prev => prev.map(f =>
        f.id === entry.id ? { ...f, status: 'error', error: err.message || 'Upload failed' } : f
      ))
    }
  }, [])

  const startUpload = useCallback(async (entry) => {
    try {
      const gid = await ensureGroup()
      await uploadFileWithProgress(entry, gid)
    } catch (err) {
      setFiles(prev => prev.map(f =>
        f.id === entry.id ? { ...f, status: 'error', error: err.message || 'Failed to create project' } : f
      ))
    }
  }, [ensureGroup, uploadFileWithProgress])

  const validateAndAddFiles = useCallback((fileList, type) => {
    const exts = [...VIDEO_EXTS, ...AUDIO_EXTS]
    const errorMsg = `Unsupported format. Accepted: ${exts.join(', ')}`

    const entries = []
    for (const file of fileList) {
      const ext = '.' + file.name.split('.').pop().toLowerCase()
      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8)

      if (!exts.includes(ext)) {
        entries.push({ id, name: file.name, file, type, status: 'error', progress: 0, error: errorMsg, xhr: null, serverId: null, durationSeconds: null })
        continue
      }
      if (file.size > MAX_SIZE) {
        entries.push({ id, name: file.name, file, type, status: 'error', progress: 0, error: 'File too large (max 50GB)', xhr: null, serverId: null, durationSeconds: null })
        continue
      }

      entries.push({ id, name: file.name, file, type, status: 'uploading', progress: 0, error: null, xhr: null, serverId: null, durationSeconds: null })
    }

    setFiles(prev => [...prev, ...entries])

    // Probe duration + dimensions in parallel for every video entry in this
    // batch (no I/O, just local moov-atom read), then start uploads. Probe
    // failures are non-fatal — the entry uploads with durationSeconds=null
    // (and width/height=null) and the server-side ffprobe / CF Stream path
    // fills the values in later as a fallback.
    ;(async () => {
      await Promise.all(entries.map(async (entry) => {
        if (entry.status !== 'uploading' || entry.type !== 'video') return
        const probed = await probeDuration(entry.file)
        if (probed != null) {
          entry.durationSeconds = Math.round(probed.duration)
          entry.width = probed.width ?? null
          entry.height = probed.height ?? null
          setFiles(prev => prev.map(f => f.id === entry.id
            ? { ...f, durationSeconds: entry.durationSeconds, width: entry.width, height: entry.height }
            : f))
        } else {
          // Diagnostic: rough-cut estimate falls back to server-side polling
          // (~30s on CF Stream) when this fires; orientation hint also misses
          // for that entry. Surfaces in the browser console for triage.
          console.warn('[probe] duration unknown for', entry.file.name, '— rough-cut + orientation will use server fallbacks')
        }
      }))
      for (const entry of entries) {
        if (entry.status === 'uploading') await startUpload(entry)
      }
    })()
  }, [startUpload])

  const handleUrlFetch = useCallback(async (urlValue, type) => {
    if (!urlValue.trim()) return
    try { new URL(urlValue) } catch {
      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      setFiles(prev => [...prev, {
        id, name: urlValue, file: null, url: urlValue, type,
        status: 'error', progress: 0, error: 'Please enter a valid URL', xhr: null, serverId: null,
      }])
      return
    }

    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    const name = urlValue.split('/').pop()?.split('?')[0] || 'Imported file'
    setFiles(prev => [...prev, { id, name, file: null, url: urlValue, type, status: 'uploading', progress: 0, error: null, xhr: null, serverId: null }])

    try {
      const gid = await ensureGroup()
      setFiles(prev => prev.map(f => f.id === id ? { ...f, progress: 30 } : f))
      const res = await apiPost('/videos/import-url', { url: urlValue, type, group_id: gid, title: name })
      setFiles(prev => prev.map(f =>
        f.id === id ? { ...f, status: 'complete', progress: 100, serverId: res.videoId } : f
      ))
    } catch (err) {
      setFiles(prev => prev.map(f =>
        f.id === id ? { ...f, status: 'error', error: err.message || 'Failed to fetch from URL' } : f
      ))
    }

    if (type === 'video') setVideoUrl('')
  }, [ensureGroup])

  const retryFile = useCallback((fileEntry) => {
    setFiles(prev => prev.map(f =>
      f.id === fileEntry.id ? { ...f, status: 'uploading', progress: 0, error: null } : f
    ))
    if (fileEntry.url) handleUrlFetch(fileEntry.url, fileEntry.type)
    else if (fileEntry.file) startUpload({ ...fileEntry, status: 'uploading', progress: 0, error: null })
  }, [handleUrlFetch, startUpload])

  const cancelFile = useCallback((fileEntry) => {
    if (fileEntry.xhr) fileEntry.xhr.abort()
    setFiles(prev => prev.filter(f => f.id !== fileEntry.id))
  }, [])

  const handleClose = () => {
    if (hasUploading) {
      if (!window.confirm('Uploads are in progress. Cancel all uploads?')) return
      files.forEach(f => { if (f.xhr && f.status === 'uploading') f.xhr.abort() })
    }
    onClose()
  }

  const handleContinue = async () => {
    // Group may still be creating — wait for it
    try {
      const gid = groupIdRef.current || await ensureGroup()
      onComplete(gid, files)
    } catch {
      // groupError state already set by ensureGroup
    }
  }

  const handleDrop = (e, type) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer?.files?.length) validateAndAddFiles(e.dataTransfer.files, type)
  }

  const prevent = (e) => { e.preventDefault(); e.stopPropagation() }

  const uploadingCount = files.filter(f => f.status === 'uploading').length

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      {/* Modal */}
      <div className="w-full max-w-[900px] max-h-[90vh] bg-[#131315] rounded-xl shadow-[0_24px_48px_rgba(0,0,0,0.8)] flex flex-col overflow-hidden border border-border-subtle/20">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border-subtle/10 shrink-0">
          <h2 className="text-xl font-bold text-white">Upload Files</h2>
          <button onClick={handleClose} className="p-2 hover:bg-surface rounded-full transition-colors">
            <X size={20} className="text-muted" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 px-6 py-6 space-y-8 overflow-y-auto">
          {groupError && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-400">
              {groupError}
            </div>
          )}

          {/* ── SECTION 1: SOURCE MEDIA ── */}
          <section className="space-y-4 p-5 rounded-xl bg-black/40 border border-border-subtle/5">
            <h3 className="text-sm font-bold uppercase tracking-widest text-lime">
              1. Upload Video(s) / Source Media
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

              {/* A. Local File */}
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-muted uppercase tracking-tight">A. Local File</label>
                <div
                  onDrop={(e) => handleDrop(e, 'video')}
                  onDragOver={prevent}
                  onClick={() => videoInputRef.current?.click()}
                  className="custom-dashed rounded-lg p-6 bg-surface/30 flex flex-col items-center justify-center gap-3 hover:bg-surface/50 transition-colors cursor-pointer group text-center min-h-[140px]"
                >
                  <span className="text-3xl text-lime/70 group-hover:text-lime transition-colors">
                    <Film />
                  </span>
                  <span className="text-xs font-medium text-muted">Click to upload .mp4, .mov, .avi</span>
                  <input
                    ref={videoInputRef}
                    type="file"
                    accept={VIDEO_ACCEPT}
                    multiple
                    className="hidden"
                    onChange={(e) => { if (e.target.files?.length) validateAndAddFiles(e.target.files, 'video'); e.target.value = '' }}
                  />
                </div>
              </div>

              {/* C. Link from Web */}
              <div className="space-y-2 flex flex-col">
                <label className="text-[10px] font-bold text-muted uppercase tracking-tight">B. Link from Web</label>
                <div className="flex-1 bg-surface/30 rounded-lg p-4 flex flex-col justify-between border border-border-subtle/5 min-h-[140px]">
                  <p className="text-xs text-muted mb-2">Paste a direct link to raw video source</p>
                  <div className="space-y-2 mt-auto">
                    <input
                      type="url"
                      placeholder="https://..."
                      value={videoUrl}
                      onChange={(e) => setVideoUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleUrlFetch(videoUrl, 'video') }}
                      className="w-full bg-black border border-border-subtle/30 focus:ring-1 focus:ring-lime/30 focus:border-lime/30 rounded-md py-2 px-3 text-sm text-white placeholder:text-muted/30 outline-none"
                    />
                    <button
                      onClick={() => handleUrlFetch(videoUrl, 'video')}
                      disabled={!videoUrl.trim()}
                      className="w-full py-2 bg-surface text-muted hover:text-white text-xs font-bold rounded transition-colors uppercase tracking-tight disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Fetch Video
                    </button>
                  </div>
                </div>
              </div>

            </div>
          </section>
        </div>

        {/* ── STICKY FOOTER ── */}
        <footer className="bg-surface border-t border-border-subtle/20 shrink-0">
          {/* Status area */}
          {hasFiles && (
            <div className="px-6 py-4 max-h-48 overflow-y-auto border-b border-border-subtle/10">
              <div className="flex items-center justify-between mb-3">
                <label className="text-[10px] font-bold uppercase tracking-wider text-muted flex items-center gap-2">
                  {hasUploading && <span className="w-1.5 h-1.5 rounded-full bg-lime animate-pulse" />}
                  {hasUploading
                    ? `Status: Uploading (${uploadingCount} File${uploadingCount !== 1 ? 's' : ''})`
                    : `${files.length} File${files.length !== 1 ? 's' : ''} Added`
                  }
                </label>
                {hasUploading && (
                  <span className="text-[10px] text-muted/60">Upload speeds may vary</span>
                )}
              </div>
              <div className="space-y-2">
                {files.map(f => (
                  <div key={f.id} className="group flex items-center gap-4 p-2 bg-black/30 rounded-lg border border-border-subtle/10 hover:border-border-subtle/30 transition-all">
                    {/* Icon */}
                    <div className="w-8 h-8 bg-surface flex items-center justify-center rounded shrink-0">
                      <span className="text-purple-accent text-lg"><Film /></span>
                    </div>
                    {/* Name + Progress */}
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center mb-1">
                        <p className="text-xs font-medium text-white truncate">{f.name}</p>
                        {f.status === 'error' ? (
                          <span className="text-[10px] text-red-400 font-bold shrink-0 ml-2">ERROR</span>
                        ) : f.status === 'complete' ? (
                          <span className="text-[10px] text-lime/80 font-bold uppercase shrink-0 ml-2">Complete</span>
                        ) : (
                          <span className="text-[10px] text-muted shrink-0 ml-2">{f.progress}%</span>
                        )}
                      </div>
                      {f.status === 'error' ? (
                        <p className="text-[10px] text-red-400 truncate">{f.error}</p>
                      ) : (
                        <div className="h-1 bg-surface-dark rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${f.status === 'complete' ? 'bg-lime/20 w-full' : 'bg-lime'}`}
                            style={f.status !== 'complete' ? { width: `${f.progress}%`, boxShadow: '0 0 8px rgba(206,252,0,0.5)' } : { width: '100%' }}
                          />
                        </div>
                      )}
                    </div>
                    {/* Type select + actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-purple-accent/10 text-purple-accent">
                        Video
                      </span>
                      {f.status === 'error' ? (
                        <button onClick={() => retryFile(f)} className="p-1 hover:bg-surface rounded text-muted hover:text-white transition-all" title="Retry">
                          <RotateCcw size={14} />
                        </button>
                      ) : (
                        <button onClick={() => cancelFile(f)} className="p-1 hover:bg-red-500/10 hover:text-red-400 rounded text-muted transition-all" title={f.status === 'uploading' ? 'Cancel' : 'Remove'}>
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Bottom actions */}
          <div className="px-6 py-4 flex items-center justify-end gap-3">
            <button
              onClick={handleClose}
              className="px-5 py-2 text-xs text-white hover:bg-surface rounded font-bold transition-all"
            >
              Cancel
            </button>
            <button
              onClick={handleContinue}
              disabled={!hasFiles}
              className="px-7 py-2.5 bg-lime text-black font-black text-xs uppercase tracking-wider rounded shadow-[0_0_15px_rgba(208,255,0,0.2)] hover:shadow-[0_0_25px_rgba(208,255,0,0.4)] transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none flex items-center gap-2"
            >
              Continue
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

/* Inline SVG icon components matching Material Symbols from the design */
function Film() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6.47L5.76 10H20v8H4V6.47M22 4h-4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4z"/>
    </svg>
  )
}

