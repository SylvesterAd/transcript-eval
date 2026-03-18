import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi.js'
import { Eye, Upload, Loader2, Film, FileVideo, ArrowUp, ArrowDown, X, Link2, Trash2, ChevronDown, ChevronRight, Camera, Star } from 'lucide-react'

export default function VideosView() {
  const { data: videos, loading, refetch } = useApi('/videos')
  const [showUpload, setShowUpload] = useState(false)
  const pollRef = useRef(null)

  // Auto-poll when any video has active transcription or group has active assembly
  // Use a stable ref to track active state and avoid re-triggering the effect
  const hasActiveRef = useRef(false)
  useEffect(() => {
    const hasActive = (videos || []).some(v =>
      (v.transcription_status && !['done', 'failed'].includes(v.transcription_status)) ||
      (v.group_assembly_status && !['done', 'failed'].includes(v.group_assembly_status))
    )
    hasActiveRef.current = hasActive
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(() => {
        if (hasActiveRef.current) refetch()
      }, 4000)
    } else if (!hasActive && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [videos, refetch])

  if (loading) return <div className="p-6 text-zinc-500 text-sm">Loading...</div>

  // Group videos by group_id
  const grouped = {}
  const ungrouped = []
  for (const v of (videos || [])) {
    if (v.group_id) {
      if (!grouped[v.group_id]) grouped[v.group_id] = {
        name: v.group_name,
        assemblyStatus: v.group_assembly_status,
        assemblyError: v.group_assembly_error,
        videos: [],
      }
      grouped[v.group_id].videos.push(v)
    } else {
      ungrouped.push(v)
    }
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Videos</h2>
        <button
          onClick={() => setShowUpload(!showUpload)}
          className="flex items-center gap-1 text-sm bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded transition-colors"
        >
          <Upload size={14} />
          Upload Video
        </button>
      </div>

      {showUpload && <VideoUploadPanel onDone={() => { setShowUpload(false); refetch() }} videos={videos} />}

      {/* Grouped videos */}
      {Object.entries(grouped).map(([gid, group]) => (
        <GroupCard key={gid} groupId={gid} group={group} onRefresh={refetch} />
      ))}

      {/* Ungrouped videos */}
      {ungrouped.length > 0 && (
        <div className="space-y-3">
          {ungrouped.map(v => (
            <div key={v.id} className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
              <VideoRow video={v} onRefresh={refetch} />
            </div>
          ))}
        </div>
      )}

      {(!videos || videos.length === 0) && !showUpload && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-zinc-500 text-sm">No videos yet. Upload one to get started.</p>
        </div>
      )}
    </div>
  )
}

function GroupCard({ groupId, group, onRefresh }) {
  const [expanded, setExpanded] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [showAnalysis, setShowAnalysis] = useState(false)
  const [detail, setDetail] = useState(null)

  const status = group.assemblyStatus
  const isActive = status && !['done', 'failed'].includes(status)

  // Load detail when expanding or when assembly completes
  useEffect(() => {
    if ((expanded || status === 'done') && !detail) {
      fetch(`/api/videos/groups/${groupId}/detail`)
        .then(r => r.json())
        .then(setDetail)
        .catch(() => {})
    }
  }, [expanded, status])

  const segments = detail?.assembly_details?.segments || []
  const overlapScores = detail?.assembly_details?.overlapScores || {}
  const videosById = Object.fromEntries((detail?.videos || group.videos).map(v => [v.id, v]))
  const totalDuration = group.videos.reduce((sum, v) => sum + (v.duration_seconds || 0), 0)
  const multicamCount = segments.filter(s => s.isMulticam).length

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      {/* Main row — single compact entry */}
      <div
        className="p-4 flex items-center gap-4 cursor-pointer hover:bg-zinc-800/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Thumbnail from first segment's primary video */}
        <div className="w-24 h-16 bg-zinc-800 rounded overflow-hidden shrink-0 flex items-center justify-center">
          {(() => {
            const firstPrimary = segments.length > 0 ? videosById[segments[0].primaryVideoId] : null
            const thumb = firstPrimary?.thumbnail_path || group.videos[0]?.thumbnail_path
            return thumb
              ? <img src={thumb} alt="" className="w-full h-full object-cover" />
              : <Film size={20} className="text-zinc-600" />
          })()}
        </div>

        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{group.name}</div>
          <div className="text-sm text-zinc-400 mt-0.5 flex gap-3 items-center flex-wrap">
            <span className="text-xs px-1.5 py-0.5 rounded border border-blue-800 bg-blue-900/30 text-blue-300">Raw</span>
            {totalDuration > 0 && <span>{formatDuration(totalDuration)}</span>}
            <span className="text-zinc-500">{group.videos.length} files</span>
            {status === 'done' && segments.length > 0 && (
              <span className="text-zinc-500">{segments.length} segments</span>
            )}
            {status === 'done' && multicamCount > 0 && (
              <span className="text-cyan-400 text-xs flex items-center gap-0.5">
                <Camera size={10} />
                {multicamCount} multicam
              </span>
            )}
            {isActive && (
              <span className="text-blue-400 text-xs flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                {status === 'transcribing' ? 'Transcribing...' : status === 'syncing' ? 'Syncing...' : status === 'ordering' ? 'Ordering...' : 'Assembling...'}
              </span>
            )}
            {status === 'failed' && (
              <span className="text-red-400 text-xs" title={group.assemblyError || ''}>
                Failed{group.assemblyError ? `: ${group.assemblyError.slice(0, 40)}` : ''}
              </span>
            )}
            {status === 'done' && (
              <span className="text-emerald-400 text-xs">Ready</span>
            )}
          </div>
        </div>

        {/* View raw video (primary) */}
        {group.videos[0] && (
          <Link to={`/videos/${(group.videos.find(v => v.video_type === 'raw') || group.videos[0]).id}`} onClick={e => e.stopPropagation()}
            className="flex items-center gap-1 text-sm text-zinc-400 hover:text-white transition-colors px-3 py-1.5 rounded hover:bg-zinc-800 shrink-0">
            <Eye size={14} /> View
          </Link>
        )}

        {/* Delete group */}
        <button onClick={async (e) => {
          e.stopPropagation()
          if (!confirm(`Delete "${group.name}" and all ${group.videos.length} videos in it?`)) return
          try {
            const res = await fetch(`/api/videos/groups/${groupId}`, { method: 'DELETE' })
            if (res.ok) onRefresh()
          } catch {}
        }}
          className="flex items-center gap-1 text-sm text-zinc-500 hover:text-red-400 transition-colors px-2 py-1.5 rounded hover:bg-zinc-800 shrink-0">
          <Trash2 size={14} />
        </button>

        {expanded ? <ChevronDown size={16} className="text-zinc-500 shrink-0" /> : <ChevronRight size={16} className="text-zinc-500 shrink-0" />}
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-zinc-800">
          {/* Assembly progress bar (while processing) */}
          {isActive && (
            <div className="px-4 py-2 border-b border-zinc-800/50 bg-zinc-800/30">
              <div className="flex items-center gap-3">
                {['transcribing', 'syncing', 'ordering', 'assembling'].map((step, i) => {
                  const steps = ['transcribing', 'syncing', 'ordering', 'assembling']
                  const currentIdx = steps.indexOf(status)
                  const isDone = i < currentIdx
                  const isCurrent = step === status
                  return (
                    <div key={step} className="flex items-center gap-1.5">
                      {isDone ? (
                        <div className="w-3.5 h-3.5 rounded-full bg-emerald-500 flex items-center justify-center text-[9px] text-black font-bold">&#10003;</div>
                      ) : isCurrent ? (
                        <Loader2 size={12} className="animate-spin text-blue-400" />
                      ) : (
                        <div className="w-3.5 h-3.5 rounded-full border border-zinc-600" />
                      )}
                      <span className={`text-[10px] ${isCurrent ? 'text-white font-medium' : isDone ? 'text-emerald-400' : 'text-zinc-600'}`}>
                        {step === 'transcribing' ? 'Transcribe' : step === 'syncing' ? 'Sync' : step === 'ordering' ? 'Order' : 'Assemble'}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Segments list */}
          {segments.length > 0 && (
            <div className="divide-y divide-zinc-800/50">
              {segments.map((seg, i) => {
                const primary = videosById[seg.primaryVideoId]
                const syncedVideos = seg.videoIds
                  .filter(id => id !== seg.primaryVideoId)
                  .map(id => videosById[id])
                  .filter(Boolean)

                return (
                  <div key={i} className="px-4 py-2.5 flex items-start gap-3">
                    <div className="w-5 h-5 rounded bg-zinc-800 flex items-center justify-center text-[10px] text-zinc-500 font-mono shrink-0 mt-0.5">
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Star size={9} className="text-amber-400 shrink-0" title="Primary" />
                        <span className="text-sm truncate">{seg.primaryTitle}</span>
                        {seg.isMulticam && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded border border-cyan-800 bg-cyan-900/30 text-cyan-300 shrink-0 flex items-center gap-0.5">
                            <Camera size={9} />
                            {seg.videoIds.length} cams
                          </span>
                        )}
                        {seg.duration && <span className="text-xs text-zinc-600">{formatDuration(seg.duration)}</span>}
                      </div>
                      {syncedVideos.length > 0 && (
                        <div className="mt-1 space-y-0.5 pl-4">
                          {syncedVideos.map(sv => (
                            <div key={sv.id} className="flex items-center gap-1.5 text-xs text-zinc-500">
                              <Camera size={9} className="text-zinc-600" />
                              <span className="truncate">{sv.title}</span>
                              {sv.duration_seconds && <span className="text-zinc-600">({formatDuration(sv.duration_seconds)})</span>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {primary && (
                      <Link to={`/videos/${primary.id}`} onClick={e => e.stopPropagation()}
                        className="flex items-center gap-1 text-xs text-zinc-500 hover:text-white transition-colors px-2 py-1 rounded hover:bg-zinc-800 shrink-0">
                        <Eye size={12} /> View
                      </Link>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {/* Fallback: show individual videos when no segments yet */}
          {segments.length === 0 && (
            <div className="divide-y divide-zinc-800/50">
              {group.videos.map(v => <VideoRow key={v.id} video={v} onRefresh={onRefresh} />)}
            </div>
          )}

          {/* Action buttons */}
          {status === 'done' && (
            <div className="px-4 py-2 border-t border-zinc-800 flex items-center gap-3">
              <button onClick={() => setShowTranscript(!showTranscript)}
                className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-1">
                {showTranscript ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Combined Transcript
              </button>
              <button onClick={() => setShowAnalysis(!showAnalysis)}
                className="text-xs text-zinc-400 hover:text-zinc-300 transition-colors flex items-center gap-1">
                {showAnalysis ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Analysis Details
              </button>
            </div>
          )}

          {/* Combined transcript */}
          {showTranscript && detail?.assembled_transcript && (
            <div className="px-4 py-3 border-t border-zinc-800/50 bg-zinc-800/20">
              <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono leading-relaxed max-h-96 overflow-auto bg-zinc-900 rounded p-3 border border-zinc-700/50">
                {detail.assembled_transcript}
              </pre>
            </div>
          )}

          {/* Analysis details */}
          {showAnalysis && detail?.assembly_details && (
            <div className="px-4 py-3 border-t border-zinc-800/50 bg-zinc-800/20 space-y-3">
              <div className="text-xs font-medium text-zinc-400">Multicam Sync Analysis</div>

              {Object.keys(overlapScores).length > 0 && (
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Transcript Overlap Scores</div>
                  <div className="grid grid-cols-2 gap-1">
                    {Object.entries(overlapScores).map(([pair, score]) => {
                      const [a, b] = pair.split('-').map(Number)
                      const allVids = detail?.videos || group.videos
                      const nameA = allVids[a]?.title || `Video ${a}`
                      const nameB = allVids[b]?.title || `Video ${b}`
                      const pct = (score * 100).toFixed(1)
                      const isMatch = score >= 0.3
                      return (
                        <div key={pair} className={`text-[11px] px-2 py-1 rounded ${isMatch ? 'bg-cyan-900/20 border border-cyan-800/30' : 'bg-zinc-800/50 border border-zinc-700/30'}`}>
                          <span className="text-zinc-400 truncate">{nameA.slice(0, 20)}</span>
                          <span className="text-zinc-600 mx-1">vs</span>
                          <span className="text-zinc-400 truncate">{nameB.slice(0, 20)}</span>
                          <span className={`ml-1 font-mono ${isMatch ? 'text-cyan-400' : 'text-zinc-500'}`}>{pct}%</span>
                        </div>
                      )
                    })}
                  </div>
                  <div className="text-[10px] text-zinc-600 mt-1">Cyan = matched as multicam (&ge;30% trigram overlap)</div>
                </div>
              )}

              <div>
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Segment Order (Gemini)</div>
                <div className="space-y-1">
                  {segments.map((seg, i) => (
                    <div key={i} className="text-[11px] flex items-center gap-2 px-2 py-1 bg-zinc-800/50 border border-zinc-700/30 rounded">
                      <span className="text-zinc-500 font-mono w-4">{i + 1}.</span>
                      <span className="text-zinc-300">{seg.primaryTitle}</span>
                      {seg.isMulticam && <span className="text-cyan-400 text-[10px]">({seg.videoIds.length} cameras)</span>}
                      {seg.duration && <span className="text-zinc-600 ml-auto">{formatDuration(seg.duration)}</span>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Gemini prompt & response */}
              {detail.assembly_details.gemini && (
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Gemini 3 Pro — Input</div>
                  <pre className="text-[11px] text-zinc-400 whitespace-pre-wrap font-mono leading-relaxed max-h-60 overflow-auto bg-zinc-900 rounded p-2.5 border border-zinc-700/30 mb-3">
                    {detail.assembly_details.gemini.prompt}
                  </pre>

                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1.5">Gemini 3 Pro — Output</div>
                  <pre className="text-[11px] whitespace-pre-wrap font-mono leading-relaxed bg-zinc-900 rounded p-2.5 border border-zinc-700/30">
                    <span className="text-emerald-400">{detail.assembly_details.gemini.response || '(no response)'}</span>
                    {detail.assembly_details.gemini.order && (
                      <span className="text-zinc-500">{'\n'}Parsed order: {JSON.stringify(detail.assembly_details.gemini.order)}</span>
                    )}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function VideoRow({ video: v, onRefresh }) {
  const [tError, setTError] = useState(null)

  const isTranscribing = v.transcription_status && !['done', 'failed'].includes(v.transcription_status)
  const needsTranscript = !isTranscribing &&
    ((v.video_type === 'raw' && !v.has_raw) || (v.video_type === 'human_edited' && !v.has_human_edited))

  async function handleTranscribe(e) {
    e.preventDefault()
    e.stopPropagation()
    setTError(null)
    try {
      const res = await fetch(`/api/videos/${v.id}/transcribe`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }))
        throw new Error(err.error)
      }
      if (onRefresh) onRefresh()
    } catch (err) {
      setTError(err.message)
    }
  }

  async function handleDelete(e) {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm(`Delete "${v.title}"? This will remove the video and all its transcripts.`)) return
    try {
      const res = await fetch(`/api/videos/${v.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Delete failed')
      if (onRefresh) onRefresh()
    } catch {}
  }

  return (
    <div className="p-4 flex items-center gap-4">
      <div className="w-24 h-16 bg-zinc-800 rounded overflow-hidden shrink-0 flex items-center justify-center">
        {v.thumbnail_path ? (
          <img src={v.thumbnail_path} alt="" className="w-full h-full object-cover" />
        ) : (
          <FileVideo size={20} className="text-zinc-600" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{v.title}</div>
        <div className="text-sm text-zinc-400 mt-0.5 flex gap-3 items-center flex-wrap">
          <TypeBadge type={v.video_type} />
          {v.duration_seconds && <span>{formatDuration(v.duration_seconds)}</span>}
          <span className={v.has_raw ? 'text-emerald-400' : 'text-zinc-600'}>Raw: {v.has_raw ? 'Yes' : 'No'}</span>
          <span className={v.has_human_edited ? 'text-emerald-400' : 'text-zinc-600'}>Human: {v.has_human_edited ? 'Yes' : 'No'}</span>
          {isTranscribing && (
            <span className="text-blue-400 text-xs flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              {v.transcription_status === 'pending' ? 'Queued...' :
               v.transcription_status === 'extracting_audio' ? 'Extracting audio...' :
               v.transcription_status?.startsWith('transcribing chunk') ? v.transcription_status.replace('transcribing', 'Transcribing') + '...' :
               v.transcription_status === 'transcribing' ? 'Whisper transcribing...' :
               v.transcription_status === 'processing' ? 'Processing...' : 'Working...'}
            </span>
          )}
          {v.transcription_status === 'failed' && (
            <span className="text-red-400 text-xs" title={v.transcription_error || ''}>
              Failed: {v.transcription_error ? v.transcription_error.slice(0, 60) : 'unknown error'}
            </span>
          )}
          {needsTranscript && !v.transcription_status && (
            <span className="text-amber-400 text-xs">Not transcribed</span>
          )}
          {tError && <span className="text-red-400 text-xs">{tError}</span>}
        </div>
      </div>

      {(needsTranscript || v.transcription_status === 'failed') && (
        <button onClick={handleTranscribe} disabled={isTranscribing}
          className="flex items-center gap-1 text-sm text-amber-400 hover:text-amber-300 transition-colors px-3 py-1.5 rounded hover:bg-zinc-800 shrink-0 disabled:opacity-50">
          <Loader2 size={14} />
          {v.transcription_status === 'failed' ? 'Retry' : 'Transcribe'}
        </button>
      )}

      <Link
        to={`/videos/${v.id}`}
        className="flex items-center gap-1 text-sm text-zinc-400 hover:text-white transition-colors px-3 py-1.5 rounded hover:bg-zinc-800"
      >
        <Eye size={14} />
        View
      </Link>

      <button onClick={handleDelete}
        className="flex items-center gap-1 text-sm text-zinc-500 hover:text-red-400 transition-colors px-2 py-1.5 rounded hover:bg-zinc-800">
        <Trash2 size={14} />
      </button>
    </div>
  )
}

function VideoUploadPanel({ onDone, videos }) {
  const [mode, setMode] = useState('upload') // upload | local | youtube
  const [files, setFiles] = useState([])
  const [localPath, setLocalPath] = useState('')
  const [youtubeUrl, setYoutubeUrl] = useState('')
  const [title, setTitle] = useState('')
  const [videoType, setVideoType] = useState('human_edited')
  const [linkVideoId, setLinkVideoId] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0) // 0-100
  const [uploadResult, setUploadResult] = useState(null)
  const [transcriptionStatus, setTranscriptionStatus] = useState(null) // pending, extracting_audio, transcribing, processing, done, failed
  const [error, setError] = useState(null)
  const [step, setStep] = useState('select') // select | uploading | transcribing | done
  const pollRef = useRef(null)

  // Get videos of opposite type for linking
  const oppositeType = videoType === 'human_edited' ? 'raw' : 'human_edited'
  const linkableVideos = (videos || []).filter(v => v.video_type === oppositeType)

  function addFiles(newFiles) {
    const arr = Array.from(newFiles)
    setFiles(prev => {
      const updated = [...prev, ...arr]
      if (!title && updated.length > 0) {
        setTitle(updated.length === 1
          ? updated[0].name.replace(/\.[^.]+$/, '')
          : updated[0].name.replace(/\.[^.]+$/, '') + (updated.length > 1 ? ` (+${updated.length - 1})` : ''))
      }
      return updated
    })
  }

  function removeFile(index) {
    setFiles(prev => {
      const updated = prev.filter((_, i) => i !== index)
      if (updated.length === 0) setTitle('')
      return updated
    })
  }

  function moveFile(index, direction) {
    setFiles(prev => {
      const arr = [...prev]
      const target = index + direction
      if (target < 0 || target >= arr.length) return arr
      ;[arr[index], arr[target]] = [arr[target], arr[index]]
      return arr
    })
  }

  // Upload FormData with XHR to get progress events
  function uploadWithProgress(url, formData) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', url)

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100)
          setUploadProgress(pct)
        }
      }

      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText)
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(data)
          } else {
            reject(new Error(data.error || `Server returned ${xhr.status}: ${xhr.statusText}`))
          }
        } catch {
          reject(new Error(`Server returned ${xhr.status}: ${xhr.responseText?.slice(0, 200) || xhr.statusText}`))
        }
      }

      xhr.onerror = () => reject(new Error('Network error: connection to server lost during upload. Check if the server is running.'))
      xhr.ontimeout = () => reject(new Error('Upload timed out after 1 hour. Try uploading smaller files.'))
      xhr.timeout = 3600000 // 1 hour

      xhr.send(formData)
    })
  }

  async function handleUpload(e) {
    e.preventDefault()

    setUploading(true)
    setStep('uploading')
    setUploadProgress(0)
    setError(null)

    let data = null

    try {
      if (mode === 'youtube') {
        if (!youtubeUrl.trim()) throw new Error('Please enter a YouTube URL')
        const res = await fetch('/api/videos/import-youtube', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: youtubeUrl.trim(),
            title: title || undefined,
            video_type: videoType,
            link_video_id: linkVideoId || undefined,
          })
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'YouTube import failed' }))
          throw new Error(err.error)
        }
        data = await res.json()
      } else if (mode === 'local') {
        if (!localPath.trim()) throw new Error('Please enter a file path')
        const res = await fetch('/api/videos/import-local', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_path: localPath.trim(),
            title: title || undefined,
            video_type: videoType,
            link_video_id: linkVideoId || undefined,
            auto_transcribe: false,
          })
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Import failed' }))
          throw new Error(err.error)
        }
        data = await res.json()
      } else {
        if (files.length === 0) throw new Error('No files selected')

        if (files.length === 1) {
          const formData = new FormData()
          formData.append('video', files[0])
          formData.append('title', title || files[0].name.replace(/\.[^.]+$/, ''))
          formData.append('video_type', videoType)
          if (linkVideoId) formData.append('link_video_id', linkVideoId)

          data = await uploadWithProgress('/api/videos/upload', formData)
        } else {
          const formData = new FormData()
          files.forEach(f => formData.append('videos', f))
          formData.append('title', title || 'Combined Video')
          formData.append('video_type', videoType)
          formData.append('order', JSON.stringify(files.map((_, i) => i)))
          if (linkVideoId) formData.append('link_video_id', linkVideoId)

          data = await uploadWithProgress('/api/videos/upload-multiple', formData)
        }
      }
    } catch (err) {
      const msg = err.message || 'Unknown error'
      const detail = mode === 'youtube' ? `YouTube import: ${msg}`
        : mode === 'local' ? `Local import: ${msg}`
        : files.length > 1 ? `Multi-file upload: ${msg}`
        : `Upload: ${msg}`
      setError(detail)
      setStep('select')
      setUploading(false)
      return
    }

    // Upload succeeded — server auto-starts transcription in background
    setUploadResult(data)
    setStep('transcribing')
    setUploading(false)

    if (data.multicam && data.groupId) {
      // Multicam raw footage: poll group assembly status
      startGroupPolling(data.groupId)
    } else {
      startPolling(data.videoId)
    }
  }

  function startPolling(videoId) {
    if (pollRef.current) clearInterval(pollRef.current)
    let consecutiveErrors = 0
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/videos/${videoId}`)
        if (!res.ok) {
          consecutiveErrors++
          if (consecutiveErrors >= 5) {
            clearInterval(pollRef.current)
            pollRef.current = null
            setError(`Lost connection to server (HTTP ${res.status}). Transcription may still be running — refresh to check.`)
            setStep('transcribe_failed')
          }
          return
        }
        consecutiveErrors = 0
        const data = await res.json()
        const status = data.transcription_status
        setTranscriptionStatus(status)

        if (status === 'done') {
          clearInterval(pollRef.current)
          pollRef.current = null
          setStep('done')
        } else if (status === 'failed') {
          clearInterval(pollRef.current)
          pollRef.current = null
          setError(data.transcription_error || 'Transcription failed (no details available)')
          setStep('transcribe_failed')
        }
      } catch (err) {
        consecutiveErrors++
        if (consecutiveErrors >= 5) {
          clearInterval(pollRef.current)
          pollRef.current = null
          setError(`Connection lost: ${err.message}. Transcription may still be running — refresh to check.`)
          setStep('transcribe_failed')
        }
      }
    }, 2000)
  }

  function startGroupPolling(groupId) {
    if (pollRef.current) clearInterval(pollRef.current)
    let consecutiveErrors = 0
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/videos/groups/${groupId}/detail`)
        if (!res.ok) {
          consecutiveErrors++
          if (consecutiveErrors >= 5) {
            clearInterval(pollRef.current)
            pollRef.current = null
            setError(`Lost connection to server (HTTP ${res.status}). Processing may still be running — refresh to check.`)
            setStep('transcribe_failed')
          }
          return
        }
        consecutiveErrors = 0
        const data = await res.json()

        const total = data.videos?.length || 0
        const done = data.videos?.filter(v => v.transcription_status === 'done').length || 0
        const failedVids = data.videos?.filter(v => v.transcription_status === 'failed') || []

        const aStatus = data.assembly_status
        if (aStatus === 'transcribing') {
          if (failedVids.length > 0) {
            setTranscriptionStatus(`transcribing ${done}/${total} (${failedVids.length} failed)`)
          } else {
            setTranscriptionStatus(`transcribing ${done}/${total}`)
          }
        } else if (['syncing', 'ordering', 'assembling'].includes(aStatus)) {
          setTranscriptionStatus(aStatus)
        } else if (aStatus === 'done') {
          clearInterval(pollRef.current)
          pollRef.current = null
          setStep('done')
        } else if (aStatus === 'failed') {
          clearInterval(pollRef.current)
          pollRef.current = null
          setError(data.assembly_error || 'Multicam analysis failed (no details available)')
          setStep('transcribe_failed')
        }
      } catch (err) {
        consecutiveErrors++
        if (consecutiveErrors >= 5) {
          clearInterval(pollRef.current)
          pollRef.current = null
          setError(`Connection lost: ${err.message}. Processing may still be running — refresh to check.`)
          setStep('transcribe_failed')
        }
      }
    }, 2000)
  }

  // Cleanup polling on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current) }, [])

  async function handleRetryTranscribe() {
    if (!uploadResult?.videoId) return
    setError(null)
    setStep('transcribing')
    setTranscriptionStatus('pending')
    try {
      await fetch(`/api/videos/${uploadResult.videoId}/transcribe`, { method: 'POST' })
      startPolling(uploadResult.videoId)
    } catch (err) {
      setError(err.message)
      setStep('transcribe_failed')
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-zinc-300">Upload Video</div>
        {step === 'select' && (
          <div className="flex gap-1 text-xs">
            <button type="button" onClick={() => setMode('upload')}
              className={`px-2 py-0.5 rounded ${mode === 'upload' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
              Upload</button>
            <button type="button" onClick={() => setMode('youtube')}
              className={`px-2 py-0.5 rounded ${mode === 'youtube' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
              YouTube</button>
            <button type="button" onClick={() => setMode('local')}
              className={`px-2 py-0.5 rounded ${mode === 'local' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}>
              Local Path</button>
          </div>
        )}
      </div>

      {/* Step: Select files & configure */}
      {step === 'select' && (
        <form onSubmit={handleUpload} className="space-y-3">
          {/* Browser upload: file drop zone */}
          {mode === 'upload' && (<>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                Video Files {files.length > 1 && <span className="text-zinc-500">— reorder below, files will be combined</span>}
              </label>
              <label className="flex items-center justify-center gap-2 w-full h-20 border-2 border-dashed border-zinc-700 rounded-lg cursor-pointer hover:border-zinc-500 transition-colors">
                <input
                  type="file"
                  accept="video/*,audio/*"
                  multiple
                  onChange={e => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = '' }}
                  className="hidden"
                />
                <div className="text-sm text-zinc-500 flex items-center gap-2">
                  <Upload size={16} />
                  Click to select files (multiple allowed)
                </div>
              </label>
            </div>

            {/* File list with reorder */}
            {files.length > 0 && (
              <div className="space-y-1">
                {files.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 bg-zinc-800/50 border border-zinc-700/50 rounded px-3 py-1.5 text-sm">
                    <span className="text-zinc-500 w-5 text-center text-xs font-mono">{i + 1}</span>
                    <FileVideo size={14} className="text-zinc-500 shrink-0" />
                    <span className="flex-1 truncate">{f.name}</span>
                    <span className="text-zinc-500 text-xs shrink-0">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                    {files.length > 1 && (
                      <>
                        <button type="button" onClick={() => moveFile(i, -1)} disabled={i === 0}
                          className="p-0.5 text-zinc-500 hover:text-white disabled:opacity-20 transition-colors"><ArrowUp size={12} /></button>
                        <button type="button" onClick={() => moveFile(i, 1)} disabled={i === files.length - 1}
                          className="p-0.5 text-zinc-500 hover:text-white disabled:opacity-20 transition-colors"><ArrowDown size={12} /></button>
                      </>
                    )}
                    <button type="button" onClick={() => removeFile(i)}
                      className="p-0.5 text-zinc-500 hover:text-red-400 transition-colors"><X size={12} /></button>
                  </div>
                ))}
                {files.length > 1 && (
                  <div className="text-xs text-amber-400/70 flex items-center gap-1 pl-1">
                    {videoType === 'raw'
                      ? 'Files will be transcribed individually, then analyzed for multicam sync'
                      : 'Files will be concatenated in this order into a single video'}
                  </div>
                )}
              </div>
            )}
          </>)}

          {/* YouTube URL input */}
          {mode === 'youtube' && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">YouTube URL</label>
              <input type="text" value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-500"
                placeholder="https://www.youtube.com/watch?v=..." />
              <div className="text-xs text-zinc-500 mt-1">Downloads MP3 audio + thumbnail, then transcribes with Whisper</div>
            </div>
          )}

          {/* Local path input */}
          {mode === 'local' && (
            <div>
              <label className="block text-xs text-zinc-400 mb-1">File Path on this machine</label>
              <input type="text" value={localPath} onChange={e => setLocalPath(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-zinc-500"
                placeholder="/Users/laurynas/path/to/video.mp4" />
              <div className="text-xs text-zinc-500 mt-1">Server will copy the file locally and transcribe it automatically</div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Name</label>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-zinc-500"
                placeholder="Video name..." />
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">Video Type</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => { setVideoType('human_edited'); setLinkVideoId('') }}
                  className={`flex-1 px-3 py-1.5 text-sm rounded border transition-colors ${
                    videoType === 'human_edited'
                      ? 'bg-purple-900/30 border-purple-700 text-purple-300'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300'
                  }`}>Human-Edited</button>
                <button type="button" onClick={() => { setVideoType('raw'); setLinkVideoId('') }}
                  className={`flex-1 px-3 py-1.5 text-sm rounded border transition-colors ${
                    videoType === 'raw'
                      ? 'bg-blue-900/30 border-blue-700 text-blue-300'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-300'
                  }`}>Raw Footage</button>
              </div>
            </div>
          </div>

          {/* Link to existing video of opposite type */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1 flex items-center gap-1">
              <Link2 size={11} />
              Link to {oppositeType === 'raw' ? 'Raw Footage' : 'Human-Edited'} (creates group)
            </label>
            {linkableVideos.length > 0 ? (
              <select value={linkVideoId} onChange={e => setLinkVideoId(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm focus:outline-none">
                <option value="">No link — upload standalone</option>
                {linkableVideos.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.title} {v.duration_seconds ? `(${formatDuration(v.duration_seconds)})` : ''} {v.group_name ? `[${v.group_name}]` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="text-xs text-zinc-500 bg-zinc-800/50 rounded px-3 py-2 border border-zinc-700/50">
                No {oppositeType === 'raw' ? 'raw footage' : 'human-edited'} videos yet — upload the other type first, or link later.
              </div>
            )}
          </div>

          <button type="submit" disabled={
            (mode === 'upload' ? files.length === 0 : mode === 'youtube' ? !youtubeUrl.trim() : !localPath.trim()) || uploading
          }
            className="bg-white text-black px-4 py-1.5 rounded text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors flex items-center gap-2">
            {mode === 'youtube' ? 'Import from YouTube & Transcribe'
              : mode === 'local' ? 'Import & Transcribe'
              : files.length > 1 ? `Upload & Combine ${files.length} Files` : 'Upload & Transcribe'}
          </button>
        </form>
      )}

      {/* Uploading / combining progress */}
      {step === 'uploading' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-zinc-300">
            <Loader2 size={14} className="animate-spin" />
            {mode === 'youtube' ? 'Downloading from YouTube...'
              : mode === 'local' ? 'Importing file...'
              : uploadProgress < 100 ? (files.length > 1 ? 'Uploading files...' : 'Uploading...')
              : files.length > 1 ? 'Combining files on server...' : 'Processing...'}
          </div>
          {mode === 'upload' && (
            <div className="space-y-1">
              <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white/80 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-zinc-500">
                <span>
                  {uploadProgress < 100
                    ? `${uploadProgress}% uploaded`
                    : files.length > 1 ? 'Upload done — combining audio on server...' : 'Upload done — processing...'}
                </span>
                <span>
                  {files.reduce((sum, f) => sum + f.size, 0) > 1024 * 1024 * 1024
                    ? `${(files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024 / 1024).toFixed(1)} GB`
                    : `${(files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024).toFixed(0)} MB`}
                </span>
              </div>
            </div>
          )}
          {mode !== 'upload' && (
            <div className="text-xs text-zinc-500">
              {mode === 'youtube' ? 'Downloading MP3 + thumbnail from YouTube...' : 'Copying file on server...'}
            </div>
          )}
        </div>
      )}

      {/* Transcribing progress */}
      {step === 'transcribing' && (
        <div className="space-y-3">
          <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-lg p-3 text-sm text-emerald-300">
            {uploadResult?.multicam
              ? `${files.length} files uploaded! Multicam analysis running...`
              : files.length > 1 ? 'Files combined successfully!' : 'Upload complete!'
            } Processing on server...
          </div>
          {uploadResult?.multicam ? (
            <MulticamProgress status={transcriptionStatus} />
          ) : (
            <TranscriptionProgress status={transcriptionStatus} />
          )}
          <div className="text-xs text-zinc-500">
            You can close this page — processing continues on the server.
          </div>
        </div>
      )}

      {/* Transcription/assembly failed but upload succeeded */}
      {step === 'transcribe_failed' && uploadResult && (
        <div className="space-y-3">
          <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-lg p-3 text-sm text-emerald-300">
            {uploadResult.multicam
              ? `${uploadResult.videos?.length || 0} videos saved`
              : `Video saved: ${uploadResult.video?.title || 'Untitled'}`}
          </div>
          <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-3 text-sm text-red-300">
            <div className="font-medium mb-1">
              {uploadResult.multicam ? 'Multicam analysis failed' : 'Transcription failed'}
            </div>
            <div className="text-xs text-red-400 font-mono">{error || 'Unknown error'}</div>
          </div>
          <div className="flex gap-2">
            {!uploadResult.multicam && (
              <button onClick={handleRetryTranscribe}
                className="bg-white text-black px-4 py-1.5 rounded text-sm font-medium hover:bg-zinc-200 transition-colors">
                Retry Transcription
              </button>
            )}
            {uploadResult.videoId && (
              <Link to={`/videos/${uploadResult.videoId}`}
                className="bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded text-sm transition-colors">View Video</Link>
            )}
            <button onClick={onDone} className="text-zinc-500 hover:text-zinc-300 px-3 py-1.5 rounded text-sm transition-colors">
              {uploadResult.multicam ? 'Close' : 'Done'}
            </button>
          </div>
        </div>
      )}

      {/* Done */}
      {step === 'done' && (
        <div className="space-y-3">
          <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-lg p-3 text-sm text-emerald-300">
            {uploadResult?.multicam
              ? `Multicam analysis complete! ${uploadResult.videos?.length || 0} files processed.`
              : files.length > 1 ? 'Files combined & transcription complete!'
              : 'Transcription complete!'}
          </div>
          <div className="flex gap-2">
            {uploadResult?.videoId && (
              <Link to={`/videos/${uploadResult.videoId}`}
                className="bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 rounded text-sm transition-colors">View Video Detail</Link>
            )}
            <button onClick={onDone} className="text-zinc-500 hover:text-zinc-300 px-3 py-1.5 rounded text-sm transition-colors">Done</button>
          </div>
        </div>
      )}

      {/* Error on upload step */}
      {error && step === 'select' && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-lg p-3 space-y-1">
          <div className="text-sm font-medium text-red-300">Error</div>
          <div className="text-xs text-red-400 font-mono">{error}</div>
        </div>
      )}
    </div>
  )
}

const TRANSCRIPTION_STAGES = [
  { key: 'pending', label: 'Queued' },
  { key: 'extracting_audio', label: 'Extracting audio' },
  { key: 'transcribing', label: 'Whisper transcribing' },
  { key: 'processing', label: 'Processing result' },
  { key: 'done', label: 'Complete' },
]

function TranscriptionProgress({ status }) {
  const currentIdx = TRANSCRIPTION_STAGES.findIndex(s => s.key === status)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {TRANSCRIPTION_STAGES.filter(s => s.key !== 'done').map((stage, i) => {
          const isActive = stage.key === status
          const isDone = currentIdx > i
          return (
            <div key={stage.key} className="flex items-center gap-1.5">
              {isDone ? (
                <div className="w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center text-[10px] text-black font-bold">&#10003;</div>
              ) : isActive ? (
                <Loader2 size={14} className="animate-spin text-white" />
              ) : (
                <div className="w-4 h-4 rounded-full border border-zinc-600" />
              )}
              <span className={`text-xs ${isActive ? 'text-white font-medium' : isDone ? 'text-emerald-400' : 'text-zinc-600'}`}>
                {stage.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const MULTICAM_STAGES = [
  { key: 'transcribing', label: 'Transcribe all' },
  { key: 'syncing', label: 'Multicam sync' },
  { key: 'ordering', label: 'Order segments' },
  { key: 'assembling', label: 'Assemble' },
  { key: 'done', label: 'Complete' },
]

function MulticamProgress({ status }) {
  // status can be "transcribing 2/4" or "syncing" etc.
  const statusKey = status?.split(' ')[0] || 'pending'
  const currentIdx = MULTICAM_STAGES.findIndex(s => s.key === statusKey)
  const transcribeDetail = status?.startsWith('transcribing') ? status.replace('transcribing ', '') : null

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {MULTICAM_STAGES.filter(s => s.key !== 'done').map((stage, i) => {
          const isActive = stage.key === statusKey
          const isDone = currentIdx > i
          return (
            <div key={stage.key} className="flex items-center gap-1.5">
              {isDone ? (
                <div className="w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center text-[10px] text-black font-bold">&#10003;</div>
              ) : isActive ? (
                <Loader2 size={14} className="animate-spin text-white" />
              ) : (
                <div className="w-4 h-4 rounded-full border border-zinc-600" />
              )}
              <span className={`text-xs ${isActive ? 'text-white font-medium' : isDone ? 'text-emerald-400' : 'text-zinc-600'}`}>
                {stage.label}{isActive && transcribeDetail && stage.key === 'transcribing' ? ` (${transcribeDetail})` : ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TypeBadge({ type }) {
  if (type === 'human_edited') {
    return <span className="text-xs px-1.5 py-0.5 rounded border border-purple-800 bg-purple-900/30 text-purple-300">Edited</span>
  }
  return <span className="text-xs px-1.5 py-0.5 rounded border border-blue-800 bg-blue-900/30 text-blue-300">Raw</span>
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
