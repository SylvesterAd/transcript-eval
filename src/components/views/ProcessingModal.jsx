import { useState, useRef, useEffect, useCallback } from 'react'
import { apiPost } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mxf', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.ts', '.mts']
const MAX_SIZE = 50 * 1024 * 1024 * 1024

export default function ProcessingModal({ groupId, initialFiles, liveFiles, onBack, onComplete }) {
  const [files, setFiles] = useState(() => (initialFiles || []).map(f => ({ ...f })))

  // Sync from live upload progress (UploadModal stays mounted and pushes updates)
  useEffect(() => {
    if (!liveFiles) return
    setFiles(prev => {
      const updated = prev.map(f => {
        const live = liveFiles.find(lf => lf.id === f.id)
        if (live && (live.progress !== f.progress || live.status !== f.status || live.loaded !== f.loaded)) {
          // Compute average speed over a 5-second window
          if (live.loaded != null && live.loaded > 0) {
            const s = speedRef.current[f.id]
            const now = Date.now()
            if (s) {
              // Push sample into ring buffer
              s.samples.push({ loaded: live.loaded, time: now })
              // Drop samples older than 5s
              const cutoff = now - 5000
              while (s.samples.length > 1 && s.samples[0].time < cutoff) s.samples.shift()
              // Compute average over the window
              const first = s.samples[0]
              const dt = (now - first.time) / 1000
              if (dt > 0.5) {
                const speed = (live.loaded - first.loaded) / dt
                const remaining = (live.total || 0) - live.loaded
                s.speed = speed
                s.eta = speed > 0 ? remaining / speed : 0
              }
            } else {
              speedRef.current[f.id] = { samples: [{ loaded: live.loaded, time: now }], speed: 0, eta: 0 }
            }
          }
          return { ...f, progress: live.progress, loaded: live.loaded, total: live.total, status: live.status, serverId: live.serverId || f.serverId, error: live.error || f.error }
        }
        return f
      })
      return updated
    })
  }, [liveFiles])
  const speedRef = useRef({}) // { [id]: { lastLoaded, lastTime, speed, eta } }
  const pollRef = useRef(null)
  const fileInputRef = useRef(null)
  const groupIdRef = useRef(groupId)
  const batchTriggeredRef = useRef(false)

  const completedRef = useRef(false)

  const cancelTranscriptions = useCallback(() => {
    if (completedRef.current) return // don't cancel if user clicked Continue
    apiPost(`/videos/groups/${groupIdRef.current}/cancel-transcriptions`, {}).catch(() => {})
  }, [])

  const handleBack = useCallback(() => {
    cancelTranscriptions()
    onBack()
  }, [cancelTranscriptions, onBack])

  const handleComplete = useCallback(() => {
    completedRef.current = true
    onComplete(groupIdRef.current, files)
  }, [onComplete, files])

  // Re-attach XHR handlers on mount for in-flight uploads
  useEffect(() => {
    for (const f of files) {
      if (!f.xhr) continue
      if (f.xhr.readyState === 4) {
        // XHR finished during transition — mark complete or error
        if (f.status === 'uploading') {
          try {
            const data = JSON.parse(f.xhr.responseText)
            if (f.xhr.status >= 200 && f.xhr.status < 300) {
              setFiles(prev => prev.map(p =>
                p.id === f.id ? { ...p, status: 'complete', progress: 100, serverId: data.videoId } : p
              ))
            } else {
              setFiles(prev => prev.map(p =>
                p.id === f.id ? { ...p, status: 'error', error: data.error || 'Upload failed' } : p
              ))
            }
          } catch {
            setFiles(prev => prev.map(p =>
              p.id === f.id ? { ...p, status: 'error', error: 'Upload failed' } : p
            ))
          }
        }
        continue
      }

      // Still in-flight — re-attach handlers
      const id = f.id
      speedRef.current[id] = { lastLoaded: 0, lastTime: Date.now(), speed: 0, eta: 0 }

      f.xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return
        const now = Date.now()
        const prev = speedRef.current[id]
        const dt = (now - prev.lastTime) / 1000
        if (dt > 0.5) {
          const dBytes = e.loaded - prev.lastLoaded
          const speed = dBytes / dt
          const remaining = e.total - e.loaded
          const eta = speed > 0 ? remaining / speed : 0
          speedRef.current[id] = { lastLoaded: e.loaded, lastTime: now, speed, eta }
        }
        const pct = Math.round((e.loaded / e.total) * 100)
        setFiles(prev => prev.map(p =>
          p.id === id ? { ...p, progress: pct, fileSize: e.total } : p
        ))
      }

      f.xhr.onload = () => {
        try {
          const data = JSON.parse(f.xhr.responseText)
          if (f.xhr.status >= 200 && f.xhr.status < 300) {
            setFiles(prev => prev.map(p =>
              p.id === id ? { ...p, status: 'complete', progress: 100, serverId: data.videoId } : p
            ))
          } else {
            setFiles(prev => prev.map(p =>
              p.id === id ? { ...p, status: 'error', error: data.error || 'Upload failed' } : p
            ))
          }
        } catch {
          setFiles(prev => prev.map(p =>
            p.id === id ? { ...p, status: 'error', error: 'Upload failed' } : p
          ))
        }
      }

      f.xhr.onerror = () => {
        setFiles(prev => prev.map(p =>
          p.id === id ? { ...p, status: 'error', error: 'Network error' } : p
        ))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only on mount

  // Bootstrap files from server if we have none (e.g. navigated here after b-roll step)
  const bootstrappedRef = useRef(false)
  useEffect(() => {
    if (files.length > 0 || bootstrappedRef.current) return
    bootstrappedRef.current = true
    ;(async () => {
      try {
        const headers = {}
        if (supabase) {
          const { data } = await supabase.auth.getSession()
          if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
        }
        const res = await fetch(`${API_BASE}/videos/groups/${groupIdRef.current}/detail`, { headers })
        if (!res.ok) return
        const data = await res.json()
        if (!data.videos?.length) return
        setFiles(data.videos.map(v => ({
          id: `server-${v.id}`,
          name: v.title || `Video ${v.id}`,
          file: null,
          type: 'video',
          status: 'complete',
          progress: 100,
          error: null,
          xhr: null,
          serverId: v.id,
          transcriptionStatus: v.transcription_status || null,
          transcriptionError: v.transcription_error || null,
        })))
      } catch {}
    })()
  }, [files.length])

  // Transcription starts automatically per-video when /register is called
  // This batch trigger is a fallback for any videos that missed auto-start
  const hasInitialFiles = (initialFiles || []).length > 0
  const allUploadsFinished = files.length > 0 && files.every(f => f.status === 'complete' || f.status === 'error')
  const classificationTriggeredRef = useRef(false)
  useEffect(() => {
    if (!allUploadsFinished) return
    if (batchTriggeredRef.current) return
    batchTriggeredRef.current = true
    apiPost(`/videos/groups/${groupIdRef.current}/transcribe`, {}).catch(() => {})
  }, [allUploadsFinished])

  // Poll for transcription status
  useEffect(() => {
    let consecutiveErrors = 0
    pollRef.current = setInterval(async () => {
      try {
        const headers = {}
        if (supabase) {
          const { data } = await supabase.auth.getSession()
          if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
        }
        const res = await fetch(`${API_BASE}/videos/groups/${groupIdRef.current}/detail`, { headers })
        if (!res.ok) {
          consecutiveErrors++
          if (consecutiveErrors >= 5) clearInterval(pollRef.current)
          return
        }
        consecutiveErrors = 0
        const data = await res.json()
        if (!data.videos) return

        setFiles(prev => prev.map(f => {
          if (f.status !== 'complete') return f
          // Match by serverId first, then by filename
          let serverVideo = f.serverId != null
            ? data.videos.find(v => v.id === f.serverId || v.id === Number(f.serverId))
            : null
          if (!serverVideo) {
            // Fallback: match by title/filename
            const name = f.name?.replace(/\.[^.]+$/, '')
            serverVideo = data.videos.find(v => v.title === name || v.title === f.name)
          }
          if (!serverVideo) return f
          const newStatus = serverVideo.transcription_status || null
          // Stamp stageStartedAt when the stage first changes (or on first observation).
          // Used downstream to render an elapsed-in-stage timer so the user can see motion
          // even when ElevenLabs is mid-call and the bar % stays fixed.
          const stageStartedAt = newStatus !== f.transcriptionStatus ? Date.now() : (f.stageStartedAt || Date.now())
          return {
            ...f,
            serverId: serverVideo.id,
            transcriptionStatus: newStatus,
            transcriptionError: serverVideo.transcription_error || null,
            fileSize: f.fileSize || serverVideo.file_size || null,
            stageStartedAt,
          }
        }))
      } catch {
        consecutiveErrors++
        if (consecutiveErrors >= 5) clearInterval(pollRef.current)
      }
    }, 2000)

    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  // 1Hz tick so the elapsed-in-stage timer in each FileCard updates between polls.
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // Cancel transcriptions when browser window/tab is closed
  useEffect(() => {
    const onBeforeUnload = () => {
      if (completedRef.current) return
      navigator.sendBeacon(
        `/api/videos/groups/${groupIdRef.current}/cancel-transcriptions`,
        new Blob(['{}'], { type: 'application/json' })
      )
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Add more files
  const uploadFileWithProgress = useCallback((entry) => {
    const formData = new FormData()
    formData.append('video', entry.file)
    formData.append('title', entry.name)
    formData.append('group_id', groupIdRef.current)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/videos/upload')

    const id = entry.id
    speedRef.current[id] = { lastLoaded: 0, lastTime: Date.now(), speed: 0, eta: 0 }

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return
      const now = Date.now()
      const prev = speedRef.current[id]
      const dt = (now - prev.lastTime) / 1000
      if (dt > 0.5) {
        const dBytes = e.loaded - prev.lastLoaded
        const speed = dBytes / dt
        const remaining = e.total - e.loaded
        const eta = speed > 0 ? remaining / speed : 0
        speedRef.current[id] = { lastLoaded: e.loaded, lastTime: now, speed, eta }
      }
      const pct = Math.round((e.loaded / e.total) * 100)
      setFiles(prev => prev.map(f =>
        f.id === id ? { ...f, progress: pct, fileSize: e.total } : f
      ))
    }

    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300) {
          setFiles(prev => prev.map(f =>
            f.id === id ? { ...f, status: 'complete', progress: 100, serverId: data.videoId } : f
          ))
        } else {
          setFiles(prev => prev.map(f =>
            f.id === id ? { ...f, status: 'error', error: data.error || 'Upload failed' } : f
          ))
        }
      } catch {
        setFiles(prev => prev.map(f =>
          f.id === id ? { ...f, status: 'error', error: 'Upload failed' } : f
        ))
      }
    }

    xhr.onerror = () => {
      setFiles(prev => prev.map(f =>
        f.id === id ? { ...f, status: 'error', error: 'Network error' } : f
      ))
    }

    xhr.timeout = 3600000
    setFiles(prev => prev.map(f => f.id === id ? { ...f, xhr } : f))
    xhr.send(formData)
  }, [])

  const handleAddFiles = useCallback((fileList) => {
    const entries = []
    for (const file of fileList) {
      const ext = '.' + file.name.split('.').pop().toLowerCase()
      const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      if (!VIDEO_EXTS.includes(ext)) {
        entries.push({ id, name: file.name, file, type: 'video', status: 'error', progress: 0, error: 'Unsupported format', xhr: null, serverId: null })
        continue
      }
      if (file.size > MAX_SIZE) {
        entries.push({ id, name: file.name, file, type: 'video', status: 'error', progress: 0, error: 'File too large (max 50GB)', xhr: null, serverId: null })
        continue
      }
      entries.push({ id, name: file.name, file, type: 'video', status: 'uploading', progress: 0, error: null, xhr: null, serverId: null, fileSize: file.size })
    }
    setFiles(prev => [...prev, ...entries])
    for (const entry of entries) {
      if (entry.status === 'uploading') uploadFileWithProgress(entry)
    }
  }, [uploadFileWithProgress])

  // Derived state
  const allUploadsComplete = files.length > 0 && files.every(f => f.status === 'complete' || f.status === 'error')
  const completedFiles = files.filter(f => f.status === 'complete')
  const allTranscriptionsComplete = completedFiles.length > 0 && completedFiles.every(
    f => f.transcriptionStatus === 'done' || f.transcriptionStatus === 'failed'
  )
  const activelyTranscribing = completedFiles.filter(f => ['waiting_for_cloudflare', 'downloading', 'extracting_audio', 'transcribing', 'processing'].includes(f.transcriptionStatus) || f.transcriptionStatus?.startsWith('transcribing chunk')).length
  const transcribedCount = completedFiles.filter(f => f.transcriptionStatus === 'done' || f.transcriptionStatus === 'failed').length
  const queuedCount = completedFiles.filter(f => !f.transcriptionStatus || f.transcriptionStatus === 'pending').length
  const uploadingCount = files.filter(f => f.status === 'uploading').length
  const totalFiles = files.filter(f => f.status !== 'error').length

  // Trigger classification once all transcriptions complete
  useEffect(() => {
    if (!allTranscriptionsComplete || classificationTriggeredRef.current) return
    classificationTriggeredRef.current = true
    console.log('[processing] All transcriptions done, triggering classification')
    apiPost(`/videos/groups/${groupIdRef.current}/reclassify`, {}).catch(() => {})
  }, [allTranscriptionsComplete])

  // Estimate total remaining time
  const totalEta = files.reduce((sum, f) => {
    if (f.status !== 'uploading') return sum
    const s = speedRef.current[f.id]
    return sum + (s?.eta || 0)
  }, 0)

  function getDisplayState(f) {
    if (f.status === 'error') return 'error'
    if (f.status === 'uploading') return 'uploading'
    if (f.status === 'complete') {
      if (f.transcriptionStatus === 'done') return 'complete'
      if (f.transcriptionStatus === 'failed') return 'error'
      // Actively transcribing stages from server
      if (f.transcriptionStatus === 'waiting_for_cloudflare'
        || f.transcriptionStatus === 'downloading' || f.transcriptionStatus === 'extracting_audio'
        || f.transcriptionStatus === 'transcribing' || f.transcriptionStatus === 'aligning'
        || f.transcriptionStatus === 'processing'
        || f.transcriptionStatus?.startsWith('transcribing chunk')) return 'transcribing'
      // pending or null — uploaded but waiting for transcription slot
      return 'queued'
    }
    return 'queued'
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec <= 0) return '...'
    if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`
    return `${(bytesPerSec / 1024).toFixed(0)} KB/s`
  }

  function formatEta(seconds) {
    if (!seconds || seconds <= 0) return '...'
    if (seconds < 60) return `${Math.ceil(seconds)}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  }

  function formatSize(bytes) {
    if (!bytes) return '...'
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
    return `${(bytes / 1024).toFixed(0)} KB`
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      {/* Modal */}
      <div className="w-full max-w-4xl bg-glass rounded-[2rem] shadow-2xl border border-outline-variant/20 flex flex-col max-h-[90vh] overflow-hidden">

        {/* Decorative accent line */}
        <div className="h-1 bg-gradient-to-r from-transparent via-primary-container/40 to-transparent" />

        {/* Header */}
        <div className="text-center p-8 pb-4">
          <h1 className="font-extrabold text-3xl lg:text-4xl text-on-surface tracking-tight">
            {uploadingCount > 0
              ? 'Uploading files...'
              : allTranscriptionsComplete
              ? 'All files processed'
              : 'Transcribing files...'}
          </h1>
          <p className="text-on-surface-variant opacity-80 mt-2">
            {uploadingCount > 0
              ? 'Please wait while we upload your files'
              : allTranscriptionsComplete
              ? 'All transcriptions are complete'
              : 'Your files are uploaded — now transcribing audio'}
          </p>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="mt-4 inline-flex items-center gap-2 px-5 py-2 rounded-full border border-outline-variant/30 text-on-surface-variant text-sm hover:bg-surface-container-highest/50 transition-colors"
          >
            <span className="material-symbols-outlined text-base">add</span>
            Add more files
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={VIDEO_EXTS.join(',')}
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files?.length) handleAddFiles(e.target.files); e.target.value = '' }}
          />
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto px-8 pb-4 space-y-3">
          {files.map(f => {
            const state = getDisplayState(f)
            const stats = speedRef.current[f.id]
            return (
              <FileCard
                key={f.id}
                file={f}
                state={state}
                speed={stats?.speed}
                eta={stats?.eta}
                formatSpeed={formatSpeed}
                formatEta={formatEta}
                formatSize={formatSize}
              />
            )
          })}
        </div>

        {/* Summary footer */}
        <div className="mx-8 mt-2 mb-8 p-6 bg-white/5 rounded-2xl border border-white/5">
          <div className="flex items-center justify-between">
            <button
              onClick={handleBack}
              className="font-black uppercase tracking-[0.15em] text-xs text-on-surface-variant hover:text-on-surface transition-colors"
            >
              Back
            </button>
            <div className="flex items-center gap-6">
              {(!allUploadsComplete || !allTranscriptionsComplete) && (
                <span className="text-[11px] italic text-on-surface-variant">
                  {uploadingCount > 0
                    ? `Uploading ${uploadingCount} of ${totalFiles} files — ~${formatEta(totalEta)} remaining`
                    : allUploadsComplete && !allTranscriptionsComplete
                    ? `${transcribedCount}/${completedFiles.length} done${activelyTranscribing > 0 ? `, ${activelyTranscribing} transcribing` : ''}${queuedCount > 0 ? `, ${queuedCount} in queue` : ''}`
                    : `Processing ${totalFiles} files...`
                  }
                </span>
              )}
              <button
                onClick={handleComplete}
                disabled={!allUploadsComplete || !allTranscriptionsComplete}
                className="bg-primary-container text-on-primary-fixed font-black uppercase tracking-[0.15em] text-xs px-8 py-3 rounded-xl shadow-[0_0_20px_rgba(206,252,0,0.2)] hover:shadow-[0_0_30px_rgba(206,252,0,0.4)] transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
              >
                {allUploadsComplete && !allTranscriptionsComplete ? 'Waiting for transcriptions...' : 'Continue'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function FileCard({ file, state, speed, eta, formatSpeed, formatEta, formatSize }) {
  if (state === 'uploading') {
    return (
      <div className="bg-surface-container-low/50 primary-glow border border-white/5 rounded-2xl p-5">
        <div className="flex items-center gap-4">
          {/* Icon */}
          <div className="w-12 h-12 rounded-xl bg-surface-container-highest flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary-container text-xl">movie</span>
          </div>
          {/* Content */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-on-surface truncate mb-2">{file.name}</p>
            <div className="flex items-center gap-4 text-xs text-on-surface-variant">
              <span className="inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">speed</span>
                {formatSpeed(speed)}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">schedule</span>
                {formatEta(eta)}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">database</span>
                {formatSize(file.fileSize)}
              </span>
            </div>
          </div>
          {/* Status + percentage */}
          <div className="text-right shrink-0">
            <span className="inline-block px-2.5 py-1 rounded-full bg-primary-container/10 text-primary-container text-[10px] font-bold uppercase tracking-wider mb-1">
              Uploading
            </span>
            <div className="text-primary-container font-mono text-lg font-bold">{file.progress}%</div>
          </div>
        </div>
        {/* Progress bar */}
        <div className="mt-3 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
          <div
            className="h-full bg-primary-container rounded-full transition-all duration-300"
            style={{ width: `${file.progress}%`, boxShadow: '0 0 12px rgba(206,252,0,0.5)' }}
          />
        </div>
      </div>
    )
  }

  if (state === 'transcribing') {
    const stage = file.transcriptionStatus
    const stageLabel = friendlyStageLabel(stage)
    const stageProgress = (stage === 'transcribing' || stage?.startsWith('transcribing chunk')) ? '60%'
      : stage === 'aligning' ? '80%'
      : stage === 'processing' ? '90%'
      : (stage === 'downloading' || stage === 'extracting_audio') ? '40%'
      : stage === 'waiting_for_cloudflare' ? '15%'
      : '20%'
    const elapsed = file.stageStartedAt ? Math.max(0, Math.floor((Date.now() - file.stageStartedAt) / 1000)) : 0
    return (
      <div className="bg-surface-container-low/50 border border-white/5 rounded-2xl p-5" style={{ boxShadow: 'inset 0 0 12px rgba(193,128,255,0.1)' }}>
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-surface-container-highest flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-secondary text-xl">audio_file</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-on-surface truncate">{file.name}</p>
            <p className="text-[13px] text-secondary font-bold mt-1 truncate">
              {stageLabel}
              {elapsed > 0 && (
                <span className="text-on-surface-variant font-normal ml-2">· {formatElapsed(elapsed)}</span>
              )}
            </p>
            <div className="flex items-center gap-3 mt-1.5 text-[11px] text-on-surface-variant">
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <span className="material-symbols-outlined text-[12px]">check_circle</span>
                Uploaded
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-[12px]">database</span>
                {formatSize(file.fileSize)}
              </span>
            </div>
          </div>
          <div className="text-right shrink-0 flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-secondary animate-pulse" />
          </div>
        </div>
        <div className="mt-3 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
          <div
            className="h-full bg-secondary rounded-full transition-all duration-700"
            style={{ width: stageProgress, boxShadow: '0 0 12px rgba(193,128,255,0.4)' }}
          />
        </div>
      </div>
    )
  }

  if (state === 'complete') {
    return (
      <div className="bg-surface-container-low/50 border border-white/5 rounded-2xl p-5">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-surface-container-highest flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-emerald-400 text-xl">check_circle</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-on-surface truncate mb-2">{file.name}</p>
            <div className="flex items-center gap-4 text-xs text-on-surface-variant">
              <span className="inline-flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">database</span>
                {formatSize(file.fileSize)}
              </span>
            </div>
          </div>
          <div className="text-right shrink-0">
            <span className="inline-block px-2.5 py-1 rounded-full bg-emerald-400/10 text-emerald-400 text-[10px] font-bold uppercase tracking-wider">
              Complete
            </span>
          </div>
        </div>
        <div className="mt-3 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
          <div className="h-full bg-emerald-400 rounded-full w-full" />
        </div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="bg-surface-container-low/50 border border-red-500/20 rounded-2xl p-5">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-surface-container-highest flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-red-400 text-xl">error</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-on-surface truncate">{file.name}</p>
            <p className="text-xs text-red-400 mt-1">{file.error || file.transcriptionError || 'Transcription failed'}</p>
          </div>
          <div className="text-right shrink-0">
            <span className="inline-block px-2.5 py-1 rounded-full bg-red-500/10 text-red-400 text-[10px] font-bold uppercase tracking-wider">
              Error
            </span>
          </div>
        </div>
      </div>
    )
  }

  // Queued (uploaded, waiting for transcription slot)
  const elapsed = file.stageStartedAt ? Math.max(0, Math.floor((Date.now() - file.stageStartedAt) / 1000)) : 0
  return (
    <div className="bg-surface-container-low/50 border border-white/5 rounded-2xl p-5">
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-surface-container-highest flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-on-surface-variant text-xl">hourglass_top</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-on-surface truncate">{file.name}</p>
          <p className="text-[13px] text-on-surface-variant font-bold mt-1 truncate">
            {friendlyStageLabel(file.transcriptionStatus)}
            {elapsed > 0 && (
              <span className="font-normal opacity-70 ml-2">· {formatElapsed(elapsed)}</span>
            )}
          </p>
          <div className="flex items-center gap-3 mt-1.5 text-[11px] text-on-surface-variant">
            <span className="inline-flex items-center gap-1 text-emerald-400">
              <span className="material-symbols-outlined text-[12px]">check_circle</span>
              Uploaded
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="material-symbols-outlined text-[12px]">database</span>
              {formatSize(file.fileSize)}
            </span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <span className="material-symbols-outlined text-on-surface-variant text-base animate-pulse">schedule</span>
        </div>
      </div>
      <div className="mt-3 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: 0 }} />
      </div>
    </div>
  )
}

function friendlyStageLabel(stage) {
  if (!stage || stage === 'pending') return 'Queued — starting soon'
  if (stage === 'waiting_for_cloudflare') return 'Cloudflare is encoding the video'
  if (stage === 'downloading') return 'Fetching encoded video'
  if (stage === 'extracting_audio') return 'Extracting audio'
  if (stage === 'transcribing') return 'Transcribing audio'
  if (stage === 'aligning') return 'Aligning timestamps'
  if (stage === 'processing') return 'Finalizing transcript'
  if (stage.startsWith('transcribing chunk')) return stage.replace('transcribing chunk', 'Transcribing part')
  return stage
}

function formatElapsed(s) {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (m < 60) return sec === 0 ? `${m}m` : `${m}m ${sec}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
