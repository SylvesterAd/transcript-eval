import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Loader2, RotateCcw } from 'lucide-react'
import { apiPost } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'
import * as tus from 'tus-js-client'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mxf', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.ts', '.mts']
const SCRIPT_EXTS = ['.docx', '.pdf', '.txt']
const VIDEO_ACCEPT = VIDEO_EXTS.join(',')
const SCRIPT_ACCEPT = SCRIPT_EXTS.join(',')
const MAX_SIZE = 50 * 1024 * 1024 * 1024 // 50GB

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
  const [scriptUrl, setScriptUrl] = useState('')
  const [groupError, setGroupError] = useState(null)
  const groupIdRef = useRef(initialGroupId || null)
  const groupPromiseRef = useRef(null)
  const videoInputRef = useRef(null)
  const scriptInputRef = useRef(null)

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

      // 1. Get Cloudflare Stream direct-upload URL
      const cfData = await apiPost('/videos/stream/create-upload', { maxDurationSeconds: 21600, file_size: entry.file.size })
      const cfUploadUrl = cfData.tusUploadUrl
      const cfStreamUid = cfData.uid
      console.log(`[upload] Cloudflare Stream upload ready for ${entry.name}: ${cfStreamUid}`)

      // 2. Upload to Cloudflare Stream via TUS (single upload — no Supabase)
      await new Promise((resolve, reject) => {
        let lastPct = -1
        const upload = new tus.Upload(entry.file, {
          endpoint: cfUploadUrl,
          retryDelays: [0, 1000, 3000, 5000],
          uploadDataDuringCreation: false,
          removeFingerprintOnSuccess: true,
          chunkSize: 6 * 1024 * 1024,
          onError: (err) => reject(new Error(err.message || 'Upload failed')),
          onProgress: (bytesUploaded, bytesTotal) => {
            const pct = Math.round((bytesUploaded / bytesTotal) * 100)
            if (pct !== lastPct) {
              lastPct = pct
              console.log(`[upload] ${entry.name}: ${pct}% (${(bytesUploaded/1024/1024).toFixed(1)}/${(bytesTotal/1024/1024).toFixed(1)} MB)`)
              setFiles(prev => prev.map(f => f.id === entryId ? { ...f, progress: pct } : f))
            }
          },
          onSuccess: () => resolve(),
          onShouldRetry: () => true,
        })
        upload.start()
      })

      // 3. Register with backend (Cloudflare only — no Supabase URL)
      setFiles(prev => prev.map(f => f.id === entry.id ? { ...f, progress: 100 } : f))

      const result = await apiPost('/videos/register', {
        filename: entry.file.name,
        title: entry.name,
        group_id: gid,
        video_type: 'raw',
        file_size: entry.file.size,
        cf_stream_uid: cfStreamUid,
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
      uploadFileWithProgress(entry, gid)
    } catch (err) {
      setFiles(prev => prev.map(f =>
        f.id === entry.id ? { ...f, status: 'error', error: err.message || 'Failed to create project' } : f
      ))
    }
  }, [ensureGroup, uploadFileWithProgress])

  const validateAndAddFiles = useCallback((fileList, type) => {
    const exts = type === 'video' ? VIDEO_EXTS : SCRIPT_EXTS
    const errorMsg = type === 'video'
      ? `Unsupported format. Accepted: ${VIDEO_EXTS.join(', ')}`
      : `Unsupported format. Accepted: ${SCRIPT_EXTS.join(', ')}`

    const entries = []
    for (const file of fileList) {
      const ext = '.' + file.name.split('.').pop().toLowerCase()
      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8)

      if (!exts.includes(ext)) {
        entries.push({ id, name: file.name, file, type, status: 'error', progress: 0, error: errorMsg, xhr: null, serverId: null })
        continue
      }
      if (file.size > MAX_SIZE) {
        entries.push({ id, name: file.name, file, type, status: 'error', progress: 0, error: 'File too large (max 50GB)', xhr: null, serverId: null })
        continue
      }

      entries.push({ id, name: file.name, file, type, status: 'uploading', progress: 0, error: null, xhr: null, serverId: null })
    }

    setFiles(prev => [...prev, ...entries])
    // Upload files sequentially to avoid overwhelming Supabase
    ;(async () => {
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
    else setScriptUrl('')
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

          {/* ── SECTION 2: SCRIPT / BRIEF ── */}
          <section className="space-y-4 p-5 rounded-xl bg-black/40 border border-border-subtle/5">
            <h3 className="text-sm font-bold uppercase tracking-widest text-lime">
              2. Upload Script / Brief
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

              {/* A. Local File */}
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-muted uppercase tracking-tight">A. Local File</label>
                <div
                  onDrop={(e) => handleDrop(e, 'script')}
                  onDragOver={prevent}
                  onClick={() => scriptInputRef.current?.click()}
                  className="custom-dashed rounded-lg p-6 bg-surface/30 flex flex-col items-center justify-center gap-3 hover:bg-surface/50 transition-colors cursor-pointer group text-center min-h-[140px]"
                >
                  <span className="text-3xl text-lime/70 group-hover:text-lime transition-colors">
                    <Description />
                  </span>
                  <span className="text-xs font-medium text-muted">Click to upload .docx, .pdf, .txt</span>
                  <input
                    ref={scriptInputRef}
                    type="file"
                    accept={SCRIPT_ACCEPT}
                    multiple
                    className="hidden"
                    onChange={(e) => { if (e.target.files?.length) validateAndAddFiles(e.target.files, 'script'); e.target.value = '' }}
                  />
                </div>
              </div>

              {/* C. Link from Web */}
              <div className="space-y-2 flex flex-col">
                <label className="text-[10px] font-bold text-muted uppercase tracking-tight">B. Link from Web</label>
                <div className="flex-1 bg-surface/30 rounded-lg p-4 flex flex-col justify-between border border-border-subtle/5 min-h-[140px]">
                  <p className="text-xs text-muted mb-2">Paste a link to your script or brief</p>
                  <div className="space-y-2 mt-auto">
                    <input
                      type="url"
                      placeholder="https://docs.google.com/..."
                      value={scriptUrl}
                      onChange={(e) => setScriptUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleUrlFetch(scriptUrl, 'script') }}
                      className="w-full bg-black border border-border-subtle/30 focus:ring-1 focus:ring-lime/30 focus:border-lime/30 rounded-md py-2 px-3 text-sm text-white placeholder:text-muted/30 outline-none"
                    />
                    <button
                      onClick={() => handleUrlFetch(scriptUrl, 'script')}
                      disabled={!scriptUrl.trim()}
                      className="w-full py-2 bg-surface text-muted hover:text-white text-xs font-bold rounded transition-colors uppercase tracking-tight disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Fetch Document
                    </button>
                  </div>
                  {/* Notion pill — disabled / coming soon */}
                  <div className="mt-3">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-surface text-xs text-muted opacity-40 cursor-not-allowed border border-border-subtle/10" title="Coming soon">
                      <svg width="14" height="14" viewBox="0 0 100 100" fill="currentColor"><path d="M6.6 12.1c4.7 3.8 6.5 3.5 15.3 2.9l58.2-3.5c1.8 0 .3-1.8-.3-2L73.3 4.6c-2.9-2.1-6.8-4.4-14.2-3.8L19.1 5.2C16 5.5 15.4 7 16.6 8l-10 4.1zM11.6 23.6v62.8c0 3.4 1.7 4.6 5.5 4.4l64.2-3.7c3.8-.2 4.3-2.5 4.3-5.2V19.5c0-2.7-1-4.1-3.3-3.8L17.1 19.3c-2.5.2-5.5 1.5-5.5 4.3zm63.4 1.9c.4 1.9 0 3.8-1.9 4l-3.1.6v46.4c-2.7 1.5-5.2 2.3-7.2 2.3-3.4 0-4.2-1.1-6.7-4.1L36.5 41.1v32.5l6.4 1.5s0 3.7-5.2 3.7l-14.3.8c-.4-.8 0-2.9 1.5-3.3l3.7-1V34.2L24 33.8c-.4-1.9.7-4.6 3.7-4.8l15.4-.9 21 32.1V30.7l-5.4-.6c-.4-2.3 1.2-4 3.3-4.2l15-1z"/></svg>
                      Notion / Other
                      <span className="text-[10px] ml-1 opacity-70">Coming soon</span>
                    </span>
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
                      {f.type === 'video'
                        ? <span className="text-purple-accent text-lg"><Film /></span>
                        : <span className="text-teal-400 text-lg"><Description /></span>
                      }
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
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${
                        f.type === 'video' ? 'bg-purple-accent/10 text-purple-accent' : 'bg-teal-400/10 text-teal-400'
                      }`}>
                        {f.type === 'video' ? 'Video' : 'Script'}
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

function Description() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor">
      <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
    </svg>
  )
}
