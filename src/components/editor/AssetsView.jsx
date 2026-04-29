import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi, apiPost } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'

function ytThumbnail(url) {
  if (!url) return null
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/)
  return m ? `https://img.youtube.com/vi/${m[1]}/mqdefault.jpg` : null
}
async function authFetch(path, opts = {}) {
  const headers = { ...opts.headers }
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  return fetch(`${API_BASE}${path}`, { ...opts, headers })
}

export default function AssetsView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, loading: initialLoading, refetch: refetchClassification } = useApi(`/videos/groups/${id}/classification`)
  const { data: refSources } = useApi(`/broll/groups/${id}/examples`)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [moveDropdown, setMoveDropdown] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [creatingGroup, setCreatingGroup] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmedGroups, setConfirmedGroups] = useState(null) // [{ id, name }] after split
  const [reclassifying, setReclassifying] = useState(false)
  const moveRef = useRef(null)

  const loading = initialLoading || reclassifying

  // Poll while classifying
  useEffect(() => {
    if (!data || data.group?.assembly_status !== 'classifying') return
    const interval = setInterval(async () => {
      try {
        const res = await authFetch(`/videos/groups/${id}/status`)
        const json = await res.json()
        if (json.assembly_status === 'classified' || json.assembly_status === 'done' || json.assembly_status === 'classification_failed') {
          clearInterval(interval)
          setReclassifying(false)
          refetchClassification()
        }
      } catch {}
    }, 1500)
    return () => clearInterval(interval)
  }, [data, id, refetchClassification])

  // Close move dropdown on outside click
  useEffect(() => {
    if (!moveDropdown) return
    const handler = (e) => {
      if (moveRef.current && !moveRef.current.contains(e.target)) setMoveDropdown(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [moveDropdown])

  const toggleSelect = (videoId) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(videoId)) next.delete(videoId)
      else next.add(videoId)
      return next
    })
  }

  const videoMap = {}
  if (data?.videos) {
    for (const v of data.videos) videoMap[v.id] = v
  }

  const groups = [...(data?.classification?.groups || [])].sort((a, b) => (b.videoIds?.length || 0) - (a.videoIds?.length || 0))
  // Sub-groups never own classification themselves — Re-classify and the
  // auto-confirm hook are disabled at this level. The user has to navigate
  // to the parent project to re-classify (where progress can be preserved
  // when the new partitioning matches the existing sub-group structure).
  const isSubGroup = !!data?.group?.parent_group_id

  // Derive confirmedGroups from API when project is already confirmed
  const effectiveConfirmedGroups = confirmedGroups || (
    data?.group?.assembly_status === 'confirmed' && data?.subGroups
      ? data.subGroups.map((sg, i) => ({
          id: sg.id,
          name: sg.name,
          videoCount: groups[i]?.videoIds?.length || 0,
          assembly_status: sg.assembly_status,
        }))
      : null
  )

  const moveToGroup = async (targetGroupName) => {
    const updated = groups.map(g => ({
      ...g,
      videoIds: g.videoIds.filter(vid => !selectedIds.has(vid)),
    }))

    let target = updated.find(g => g.name === targetGroupName)
    if (!target) {
      target = { name: targetGroupName, videoIds: [] }
      updated.push(target)
    }
    target.videoIds.push(...selectedIds)

    // Remove empty groups
    const filtered = updated.filter(g => g.videoIds.length > 0)

    try {
      const json = await apiPost(`/videos/groups/${id}/update-classification`, { groups: filtered })
      if (json.ok) {
        refetchClassification()
        setSelectedIds(new Set())
        setMoveDropdown(false)
        setCreatingGroup(false)
        setNewGroupName('')
      }
    } catch {}
  }

  const handleConfirm = async () => {
    setConfirming(true)
    try {
      const json = await apiPost(`/videos/groups/${id}/confirm-classification`, { groups })
      if (json.ok) {
        const confirmed = json.groupIds.map((gId, i) => ({
          id: gId,
          name: groups[i]?.name || `Group ${i + 1}`,
          videoCount: groups[i]?.videoIds?.length || 0,
        }))
        setConfirmedGroups(confirmed)
      }
    } catch {}
    setConfirming(false)
  }

  // Auto-confirm + advance for single-video projects (no multi-cam means there's nothing
  // to sync, and surfacing an extra Confirm button is just friction). Fires only once
  // per mount via autoConfirmRef so we don't loop on re-renders.
  // Sub-groups are explicitly skipped — confirming a sub-group would create a
  // recursive sub-sub-group (the 239→240→241 bug pattern).
  const autoConfirmRef = useRef(false)
  useEffect(() => {
    if (autoConfirmRef.current) return
    if (isSubGroup) return
    if (data?.group?.assembly_status !== 'classified') return
    if (groups.length !== 1 || (groups[0].videoIds?.length || 0) !== 1) return
    autoConfirmRef.current = true
    ;(async () => {
      try {
        const json = await apiPost(`/videos/groups/${id}/confirm-classification`, { groups })
        if (json.ok) {
          setConfirmedGroups(json.groupIds.map((gId, i) => ({
            id: gId,
            name: groups[i]?.name || `Group ${i + 1}`,
            videoCount: groups[i]?.videoIds?.length || 0,
          })))
        }
      } catch {}
    })()
  }, [id, data?.group?.assembly_status, groups, isSubGroup])

  // After auto-confirm completes, jump straight to the editor — skipping the
  // "Proceed to Editor" click. Only fires for the auto-confirm path; users who
  // confirmed manually still see the button so they can review before advancing.
  useEffect(() => {
    if (!autoConfirmRef.current) return
    if (!effectiveConfirmedGroups || effectiveConfirmedGroups.length !== 1) return
    navigate(`/editor/${effectiveConfirmedGroups[0].id}/sync`, { replace: true })
  }, [effectiveConfirmedGroups, navigate])

  const handleReclassify = async () => {
    // Server enforces this too, but bail early on the client to avoid even
    // showing a confirmation prompt on a sub-group (where the action would
    // 403 anyway).
    if (isSubGroup) return
    const proceed = window.confirm(
      'Re-classify will check whether your videos still group the same way. ' +
      'If they do, your rough cut and b-roll progress are preserved. ' +
      'If the grouping changes, that progress will be discarded.\n\nContinue?'
    )
    if (!proceed) return

    setReclassifying(true)
    setConfirmedGroups(null)
    setSelectedIds(new Set())
    try {
      const json = await apiPost(`/videos/groups/${id}/reclassify`)
      if (json?.unchanged) {
        // Same structure: parent stays at 'confirmed'; refetching wouldn't show
        // the re-classify spinner go away because status didn't flip. Stop the
        // spinner manually and surface a brief note.
        setReclassifying(false)
        window.alert('Videos still group the same way — your progress was preserved.')
      }
    } catch {}
    // Poll will pick up the status change for the "different" path
    refetchClassification()
  }

  if (loading || data?.group?.assembly_status === 'classifying') {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <span className="material-symbols-outlined animate-spin text-4xl text-primary-fixed">progress_activity</span>
          <p className="text-on-surface-variant text-sm">Classifying videos...</p>
        </div>
      </main>
    )
  }

  if (data?.group?.assembly_status === 'classification_failed') {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <span className="material-symbols-outlined text-4xl text-error">error</span>
          <h2 className="text-lg font-bold text-on-surface">Classification Failed</h2>
          <p className="text-sm text-on-surface-variant">{data.group.assembly_error || 'Unknown error'}</p>
          <button
            onClick={handleReclassify}
            className="flex items-center gap-2 px-6 py-2.5 mt-2 rounded-lg text-sm font-bold bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 transition-all"
          >
            <span className="material-symbols-outlined text-lg">refresh</span>
            Re-Classify
          </button>
        </div>
      </main>
    )
  }

  const formatFilesize = (bytes) => {
    if (!bytes) return null
    if (bytes > 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  const formatDuration = (s) => {
    if (!s) return ''
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${String(sec).padStart(2, '0')}`
  }

  const formatRes = (w, h) => {
    if (!w || !h) return null
    if (h >= 2160) return '4K'
    if (h >= 1440) return '2K'
    if (h >= 1080) return '1080P'
    if (h >= 720) return '720P'
    return `${w}x${h}`
  }

  return (
    <main className="flex-1 p-8 overflow-y-auto custom-scrollbar">
      {/* Header */}
      <div className="mb-10 flex justify-between items-end">
        <div>
          <h1 className="font-headline text-4xl font-extrabold tracking-tighter text-on-surface mb-2">Project Assets</h1>
          <p className="text-on-surface-variant text-sm">{effectiveConfirmedGroups ? 'Organize and sync your raw footage for the kinetic editor.' : (data?.group?.name || '')}</p>
        </div>
        <div className="flex gap-3">
          {!isSubGroup && (
            <button
              onClick={handleReclassify}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-on-surface-variant hover:bg-surface-container-highest/50 transition-colors"
            >
              <span className="material-symbols-outlined text-lg">refresh</span>
              Re-classify
            </button>
          )}
          {!effectiveConfirmedGroups && groups.length > 0 && data?.group?.assembly_status === 'classified' && (
            <button
              onClick={handleConfirm}
              disabled={confirming}
              className="flex items-center gap-2 px-6 py-2 rounded-lg text-sm font-bold bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 transition-all disabled:opacity-50"
            >
              {confirming ? (
                <span className="material-symbols-outlined animate-spin text-lg">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-lg">check_circle</span>
              )}
              Confirm & Start Sync
            </button>
          )}
        </div>
      </div>

      {/* Group Sections */}
      {groups.map((group, i) => {
        const isMain = i === 0
        const videos = group.videoIds.map(vid => videoMap[vid]).filter(Boolean)
        const confirmedGroup = effectiveConfirmedGroups?.find((_, idx) => idx === i)

        return (
          <section key={group.name} className={`space-y-6 ${!isMain ? 'pt-12 border-t border-white/5' : ''} ${!isMain && !effectiveConfirmedGroups ? 'opacity-60 hover:opacity-100 transition-opacity' : ''} mb-10`}>
            {/* Group header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <h2 className={`font-headline text-xl font-bold ${isMain ? 'text-on-surface' : 'text-on-surface-variant'}`}>
                  {group.name}
                </h2>
                <span className={`px-2 py-0.5 text-[10px] font-bold rounded uppercase tracking-widest ${
                  isMain ? 'bg-primary-fixed/10 text-primary-fixed border border-primary-fixed/20' : 'bg-surface-container-highest text-on-surface-variant'
                }`}>
                  {videos.length} {videos.length === 1 ? 'Clip' : 'Clips'} Found
                </span>
              </div>
              {confirmedGroup && (
                <button
                  onClick={() => navigate(`/editor/${confirmedGroup.id}/sync`)}
                  className={`group flex items-center gap-3 px-6 py-2.5 rounded-md transition-all active:scale-95 ${
                    isMain
                      ? 'bg-gradient-to-r from-primary-fixed to-primary-container text-on-primary-fixed hover:shadow-[0_0_20px_rgba(206,252,0,0.4)]'
                      : 'bg-surface-container-highest hover:bg-surface-bright text-on-surface border border-outline-variant/20'
                  }`}
                >
                  <span className="font-label text-sm font-black uppercase tracking-tighter">Proceed to Editor</span>
                  <span className="material-symbols-outlined text-lg group-hover:translate-x-1 transition-transform">arrow_forward</span>
                </button>
              )}
            </div>

            {/* Grid */}
            <div className="grid grid-cols-4 gap-6">
              {videos.map(video => {
                const mi = video.media_info
                const isSelected = selectedIds.has(video.id)
                const res = formatRes(mi?.width, mi?.height)
                const fps = mi?.fps ? `${mi.fps}FPS` : null
                const size = formatFilesize(mi?.filesize)
                const meta = [res, fps, size].filter(Boolean).join(' \u2022 ')

                return (
                  <div
                    key={video.id}
                    onClick={() => !effectiveConfirmedGroups && toggleSelect(video.id)}
                    className={`bg-surface-container-low rounded-xl overflow-hidden group relative ${effectiveConfirmedGroups ? '' : 'cursor-pointer'} hover:ring-2 ring-primary-fixed/50 transition-all`}
                    style={isSelected ? { boxShadow: 'inset 0 0 0 2px #cefc00, 0 0 15px rgba(206, 252, 0, 0.2)' } : undefined}
                  >
                    {/* Selection circle */}
                    {!effectiveConfirmedGroups && (
                      <div className={`absolute top-3 left-3 z-20 w-6 h-6 rounded-full flex items-center justify-center transition-all ${
                        isSelected
                          ? 'bg-primary-container'
                          : 'bg-surface-container-low/80 border-2 border-outline-variant/50 opacity-0 group-hover:opacity-100'
                      }`}>
                        {isSelected && <span className="material-symbols-outlined text-on-primary-fixed text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>check</span>}
                      </div>
                    )}

                    {/* Thumbnail */}
                    <div className="aspect-video relative overflow-hidden bg-surface-container-highest">
                      {video.thumbnail_path ? (
                        <img
                          src={video.thumbnail_path}
                          alt={video.title}
                          className="w-full h-full object-cover opacity-90 group-hover:scale-105 transition-transform duration-500"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="material-symbols-outlined text-3xl text-on-surface-variant/30">videocam</span>
                        </div>
                      )}
                      {/* Duration badge */}
                      {video.duration_seconds && (
                        <span className="absolute bottom-2 right-2 bg-black/80 backdrop-blur-md rounded px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-on-surface">
                          {formatDuration(video.duration_seconds)}
                        </span>
                      )}
                    </div>

                    {/* Info */}
                    <div className="p-3">
                      <p className="text-sm font-bold text-on-surface truncate">{video.title}</p>
                      {meta && (
                        <p className="text-[10px] tracking-widest uppercase text-on-surface-variant mt-1">{meta}</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}

      {/* Reference Videos */}
      {refSources?.length > 0 && (
        <section className="space-y-6 pt-12 border-t border-white/5 mb-10">
          <div className="flex items-center gap-4">
            <h2 className="font-headline text-xl font-bold text-on-surface-variant">Reference Videos</h2>
            <span className="px-2 py-0.5 text-[10px] font-bold rounded uppercase tracking-widest bg-[#c180ff]/10 text-[#c180ff] border border-[#c180ff]/20">
              {refSources.length} {refSources.length === 1 ? 'Reference' : 'References'}
            </span>
            <span className="text-[10px] text-on-surface-variant/60 uppercase tracking-wider">B-Roll AI Context</span>
          </div>
          <div className="grid grid-cols-4 gap-6">
            {refSources.map(source => {
              const thumb = ytThumbnail(source.source_url) || (source.meta_json && JSON.parse(source.meta_json || '{}').thumbnailUrl)
              const label = source.label || source.source_url || `Reference #${source.id}`
              return (
                <div key={source.id} className="bg-surface-container-low rounded-xl overflow-hidden relative opacity-70 hover:opacity-100 transition-opacity">
                  <div className="aspect-video relative overflow-hidden bg-surface-container-highest">
                    {thumb ? (
                      <img src={thumb} alt={label} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <span className="material-symbols-outlined text-3xl text-on-surface-variant/30">smart_display</span>
                      </div>
                    )}
                    {source.is_favorite && (
                      <span className="absolute top-2 right-2 material-symbols-outlined text-[#cefc00] text-base" style={{ fontVariationSettings: '"FILL" 1' }}>star</span>
                    )}
                    <span className={`absolute bottom-2 right-2 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                      source.status === 'ready' ? 'bg-[#cefc00]/20 text-[#cefc00]' :
                      source.status === 'processing' ? 'bg-[#c180ff]/20 text-[#c180ff] animate-pulse' :
                      source.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                      'bg-white/10 text-on-surface-variant'
                    }`}>
                      {source.status}
                    </span>
                  </div>
                  <div className="p-3">
                    <p className="text-sm font-bold text-on-surface truncate">{label}</p>
                    <p className="text-[10px] tracking-widest uppercase text-on-surface-variant mt-1">
                      {source.kind === 'yt_video' ? 'YouTube' : source.kind === 'upload' ? 'Local Upload' : source.kind.replace('_', ' ')}
                      {source.is_favorite ? ' \u2022 Favorite' : ''}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Bottom Action Bar */}
      {selectedIds.size > 0 && !effectiveConfirmedGroups && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2">
          {/* Badge */}
          <span className="bg-primary-container text-on-primary-fixed text-[10px] font-bold uppercase tracking-widest rounded-full px-3 py-1">
            {selectedIds.size} selected
          </span>

          {/* Bar */}
          <div className="bg-[#1a1a1c]/80 backdrop-blur-xl rounded-2xl border border-[#f4ffc8]/10 shadow-[0_32px_64px_-12px_rgba(0,0,0,0.8)] flex items-center px-4 py-2.5 gap-3" ref={moveRef}>
            {/* Move to Group */}
            <div className="relative">
              <button
                onClick={() => setMoveDropdown(!moveDropdown)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-on-surface hover:bg-surface-container-highest/50 transition-colors"
              >
                <span className="material-symbols-outlined text-lg">folder_shared</span>
                Move to Group
              </button>

              {moveDropdown && (
                <div className="absolute bottom-full mb-2 left-0 w-56 bg-[#1a1a1c] border border-outline-variant/20 rounded-xl shadow-2xl overflow-hidden">
                  {groups.map(g => (
                    <button
                      key={g.name}
                      onClick={() => moveToGroup(g.name)}
                      className="w-full text-left px-4 py-2.5 text-sm text-on-surface hover:bg-surface-container-highest/50 transition-colors"
                    >
                      {g.name}
                    </button>
                  ))}
                  <div className="border-t border-outline-variant/10">
                    {creatingGroup ? (
                      <div className="flex items-center gap-2 px-4 py-2">
                        <input
                          autoFocus
                          maxLength={30}
                          value={newGroupName}
                          onChange={(e) => setNewGroupName(e.target.value.toUpperCase())}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && newGroupName.trim()) {
                              moveToGroup(newGroupName.trim())
                            }
                          }}
                          placeholder="NAME"
                          className="flex-1 bg-transparent border border-outline-variant/30 rounded px-2 py-1 text-sm text-on-surface placeholder:text-on-surface-variant/40 outline-none focus:border-primary-fixed"
                        />
                        <button
                          onClick={() => newGroupName.trim() && moveToGroup(newGroupName.trim())}
                          className="text-primary-fixed text-sm font-bold"
                        >
                          Add
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setCreatingGroup(true)}
                        className="w-full text-left px-4 py-2.5 text-sm text-primary-fixed font-semibold hover:bg-surface-container-highest/50 transition-colors"
                      >
                        + New Group...
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="w-px h-8 bg-on-surface/10" />

            {/* Delete */}
            <button
              onClick={() => setSelectedIds(new Set())}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold text-error hover:bg-error/10 transition-colors"
            >
              <span className="material-symbols-outlined text-lg">delete_forever</span>
              Deselect
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
