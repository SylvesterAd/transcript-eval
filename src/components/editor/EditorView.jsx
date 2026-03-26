import { createContext, useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useApi } from '../../hooks/useApi.js'
import useEditorState from './useEditorState.js'
import EditorSidebar from './EditorSidebar.jsx'
import VideoPreviewGrid from './VideoPreviewGrid.jsx'
import PlaybackControls from './PlaybackControls.jsx'
import Timeline from './Timeline.jsx'
import TranscriptEditor from './TranscriptEditor.jsx'
import RoughCutPreview from './RoughCutPreview.jsx'

export const EditorContext = createContext(null)

export default function EditorView() {
  const { id, tab } = useParams()
  const navigate = useNavigate()
  const { data: groupDetail, loading, error, refetch: refetchDetail } = useApi(`/videos/groups/${id}/detail`)
  const { data: wordTimestamps, refetch: refetchTimestamps } = useApi(`/videos/groups/${id}/word-timestamps`)
  const { state, dispatch, totalDuration, formatTime } = useEditorState()

  // URL tab is source of truth — sync to state before paint
  const activeTab = tab || 'sync'
  useLayoutEffect(() => {
    if (state.activeTab !== activeTab) {
      dispatch({ type: 'SET_ACTIVE_TAB', payload: activeTab })
    }
  }, [activeTab, state.activeTab, dispatch])

  const videoRefs = useRef({})
  const playbackEngine = useRef(null)
  const playheadRef = useRef(null)
  const rafId = useRef(null)
  const startRealTime = useRef(0)
  const startPlayheadTime = useRef(0)
  const throttleRef = useRef(0)

  // Initialize tracks when data arrives
  useEffect(() => {
    if (!groupDetail) return
    const timeline = groupDetail.timeline
    const restoredState = groupDetail.editor_state
    const derived = deriveFromTimeline(timeline, groupDetail.videos)
    dispatch({
      type: 'INIT_TRACKS',
      payload: {
        groupId: parseInt(id),
        groupDetail,
        tracks: derived.tracks,
        groups: derived.groups,
        restoredState,
      }
    })
  }, [groupDetail, id, dispatch])

  // Trigger server-side frame extraction for existing projects that don't have frames yet
  useEffect(() => {
    if (!groupDetail?.videos) return
    const needsFrames = groupDetail.videos.some(v => v.frames_status !== 'done' && v.frames_status !== 'extracting')
    if (needsFrames) {
      fetch(`/api/videos/groups/${id}/extract-frames`, { method: 'POST' }).catch(() => {})
    }
  }, [groupDetail, id])

  // Load word timestamps — re-runs when tracks change (e.g. after INIT_TRACKS)
  // to handle the case where timestamps loaded before tracks were populated
  useEffect(() => {
    if (!wordTimestamps || !state.groupId || state.tracks.length === 0) return
    dispatch({ type: 'SET_WORD_TIMESTAMPS', payload: { wordTimestamps } })
  }, [wordTimestamps, state.groupId, state.tracks.length, dispatch])

  // Playback engine (rAF loop) — media-driven clock
  // Uses the master video element's currentTime as the time source instead of
  // performance.now(). This avoids constant seeking when audio output is buffered
  // (e.g. Bluetooth speakers add 100-300ms latency that desync wall clock from media time).
  const tick = useCallback(() => {
    const now = performance.now()
    const videoTracks = state.tracks.filter(t => t.type === 'video')

    // Find master element: prefer unmuted active track, fall back to any playing track
    let masterEl = null
    let masterTrack = null
    for (const track of videoTracks) {
      const el = videoRefs.current[track.videoId]
      if (!el || el.paused || el.readyState < 2) continue
      const audioTrack = state.tracks.find(t => t.type === 'audio' && t.videoId === track.videoId)
      const isUnmuted = audioTrack && !audioTrack.muted
      if (isUnmuted || !masterEl) {
        masterEl = el
        masterTrack = track
        if (isUnmuted) break
      }
    }

    // Derive timeline time from master, fall back to wall clock during gaps
    let newTime
    if (masterEl) {
      newTime = masterEl.currentTime + masterTrack.offset
      // Keep wall-clock baseline in sync for seamless fallback
      startPlayheadTime.current = newTime
      startRealTime.current = now
    } else {
      // Check if tracks should be active but elements are still buffering
      // Only consider tracks that have a mounted video element (visible in preview)
      const shouldBeActive = videoTracks.some(t => {
        if (!videoRefs.current[t.videoId]) return false
        const localTime = startPlayheadTime.current - t.offset
        return localTime >= 0 && localTime <= t.duration
      })
      if (shouldBeActive) {
        // Hold position until master is ready — avoids startup stutter
        newTime = startPlayheadTime.current
      } else {
        // Gap between tracks — advance via wall clock
        const elapsed = (now - startRealTime.current) / 1000
        newTime = startPlayheadTime.current + elapsed * state.playbackRate
      }
    }

    // Stop at end
    if (newTime >= totalDuration) {
      dispatch({ type: 'SET_CURRENT_TIME', payload: totalDuration })
      dispatch({ type: 'PAUSE' })
      stopAllVideos()
      return
    }

    // Skip cut regions in rough cut mode
    if (state.activeTab === 'roughcut' && state.cuts.length > 0) {
      const preSkipTime = newTime
      let skipping = true
      while (skipping) {
        skipping = false
        for (const cut of state.cuts) {
          if (newTime >= cut.start && newTime < cut.end) {
            newTime = cut.end
            skipping = true
            break
          }
        }
      }
      if (newTime !== preSkipTime) {
        startPlayheadTime.current = newTime
        startRealTime.current = now
        for (const vt of videoTracks) {
          const el = videoRefs.current[vt.videoId]
          if (el) {
            const lt = newTime - vt.offset
            if (lt >= 0 && lt <= vt.duration) el.currentTime = lt
          }
        }
        if (newTime >= totalDuration) {
          dispatch({ type: 'SET_CURRENT_TIME', payload: totalDuration })
          dispatch({ type: 'PAUSE' })
          stopAllVideos()
          return
        }
      }
    }

    // In Main Track mode, find the active videoId at the current time
    // (the video whose segment covers the playhead — same logic as composite track)
    const isMainMode = state.activeTab === 'roughcut' && state.roughCutTrackMode === 'main'
    let mainActiveVideoId = null
    if (isMainMode) {
      const sorted = [...videoTracks].sort((a, b) => a.offset - b.offset)
      let covered = 0
      for (const t of sorted) {
        const tEnd = t.offset + t.duration
        if (tEnd <= covered) continue
        const segStart = Math.max(t.offset, covered)
        if (segStart >= tEnd) continue
        if (newTime >= segStart && newTime < tEnd) { mainActiveVideoId = t.videoId; break }
        covered = tEnd
      }
      if (!mainActiveVideoId && sorted.length) mainActiveVideoId = sorted[0].videoId
    }

    // Sync video elements
    for (const track of videoTracks) {
      const el = videoRefs.current[track.videoId]
      if (!el) continue
      const localTime = newTime - track.offset
      if (localTime >= 0 && localTime <= track.duration) {
        // Drift correction — never seek the master (it IS the clock), generous threshold for others
        if (el !== masterEl && Math.abs(el.currentTime - localTime) > 0.3) {
          el.currentTime = localTime
        }
        el.playbackRate = state.playbackRate

        // Audio: in Main Track mode, only unmute the active segment's video.
        // In All Tracks mode, unmute per the track's mute setting.
        const audioTrack = state.tracks.find(t => t.type === 'audio' && t.videoId === track.videoId)
        if (isMainMode) {
          if (track.videoId === mainActiveVideoId) {
            el.muted = false
            el.volume = state.volume
          } else {
            el.muted = true
          }
        } else if (audioTrack && !audioTrack.muted) {
          el.muted = false
          el.volume = state.volume
        } else {
          el.muted = true
        }

        // Play video element if visible OR if its audio is needed
        if (el.paused && (track.visible || (!el.muted))) {
          el.play().catch(() => {})
        }
      } else {
        if (!el.paused) el.pause()
        el.muted = true
      }
    }

    // Update playhead via ref (60fps, no React re-render)
    if (playheadRef.current) {
      const x = newTime * state.zoom
      playheadRef.current.style.transform = `translateX(${x}px)`
    }

    // Throttle state update to ~10Hz
    if (now - throttleRef.current > 100) {
      throttleRef.current = now
      dispatch({ type: 'SET_CURRENT_TIME', payload: newTime })
    }

    rafId.current = requestAnimationFrame(tick)
  }, [state.tracks, state.playbackRate, state.zoom, state.volume, state.activeTab, state.roughCutTrackMode, state.cuts, totalDuration, dispatch])

  const stopAllVideos = useCallback(() => {
    Object.values(videoRefs.current).forEach(el => {
      if (el && !el.paused) el.pause()
      if (el) el.muted = true
    })
  }, [])

  // Start/stop rAF based on isPlaying
  useEffect(() => {
    if (state.isPlaying) {
      startRealTime.current = performance.now()
      startPlayheadTime.current = state.currentTime
      rafId.current = requestAnimationFrame(tick)
    } else {
      cancelAnimationFrame(rafId.current)
      stopAllVideos()
    }
    return () => cancelAnimationFrame(rafId.current)
  }, [state.isPlaying, tick, stopAllVideos])

  // Playback engine API exposed via ref
  useEffect(() => {
    playbackEngine.current = {
      play() {
        startRealTime.current = performance.now()
        startPlayheadTime.current = state.currentTime
      },
      pause() {
        stopAllVideos()
      },
      seek(time) {
        startPlayheadTime.current = time
        startRealTime.current = performance.now()
        // Immediately seek all videos
        state.tracks.filter(t => t.type === 'video').forEach(track => {
          const el = videoRefs.current[track.videoId]
          if (el) {
            const localTime = time - track.offset
            if (localTime >= 0 && localTime <= track.duration) {
              el.currentTime = localTime
            }
          }
        })
        if (playheadRef.current) {
          playheadRef.current.style.transform = `translateX(${time * state.zoom}px)`
        }
      },
      setRate(rate) {
        startPlayheadTime.current = state.currentTime
        startRealTime.current = performance.now()
        Object.values(videoRefs.current).forEach(el => {
          if (el) el.playbackRate = rate
        })
      }
    }
  }, [state.currentTime, state.tracks, state.zoom, stopAllVideos])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        if (state.isPlaying) {
          dispatch({ type: 'PAUSE' })
          playbackEngine.current?.pause()
        } else {
          dispatch({ type: 'PLAY' })
          playbackEngine.current?.play()
        }
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        const t = Math.max(0, state.currentTime - 5)
        dispatch({ type: 'SET_CURRENT_TIME', payload: t })
        playbackEngine.current?.seek(t)
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        const t = Math.min(totalDuration, state.currentTime + 5)
        dispatch({ type: 'SET_CURRENT_TIME', payload: t })
        playbackEngine.current?.seek(t)
      } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (e.shiftKey) {
          dispatch({ type: 'REDO' })
        } else {
          dispatch({ type: 'UNDO' })
        }
      } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        dispatch({ type: 'REDO' })
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [state.isPlaying, state.currentTime, totalDuration, dispatch])

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0e0e10] text-on-surface-variant">
        <span className="material-symbols-outlined animate-spin text-3xl">progress_activity</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-[#0e0e10] text-on-surface-variant">
        <p>Failed to load project: {error}</p>
      </div>
    )
  }

  // Show syncing screen if assembly is still in progress
  const assemblyStatus = groupDetail?.assembly_status
  const isAssembling = assemblyStatus && !['done', 'error'].includes(assemblyStatus)
  if (isAssembling) {
    return <SyncingScreen groupId={id} status={assemblyStatus} onDone={() => { refetchDetail(); refetchTimestamps() }} />
  }

  if (assemblyStatus === 'error') {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-[#0e0e10] text-on-surface-variant gap-4">
        <span className="material-symbols-outlined text-4xl text-red-400">error</span>
        <p className="text-sm">Sync failed: {groupDetail?.assembly_error || 'Unknown error'}</p>
        <Link to="/" className="text-primary-fixed text-sm hover:underline">Back to projects</Link>
      </div>
    )
  }

  return (
    <EditorContext.Provider value={{ state, dispatch, videoRefs, playbackEngine, playheadRef, totalDuration, formatTime, refetchDetail, refetchTimestamps }}>
      <div className="h-screen flex flex-col overflow-hidden bg-[#0e0e10] text-on-surface font-['Inter',sans-serif]">
        {/* Top nav */}
        <header className="flex justify-between items-center w-full px-6 h-14 bg-[#0e0e10] z-50 shrink-0">
          <div className="flex items-center gap-8">
            <span className="text-primary-fixed font-bold text-lg tracking-tight">Studio</span>
            <div className="flex items-center gap-6 h-full pl-4">
              <Link to="/" className="text-on-surface/60 hover:text-on-surface font-bold text-sm transition-colors">Projects</Link>
              <div className="relative h-14 flex items-center">
                <span className="text-primary-fixed font-bold text-sm">Editor</span>
                <div className="absolute bottom-0 left-0 w-full h-0.5 bg-primary-fixed shadow-[0_0_8px_rgba(206,252,0,0.4)]" />
              </div>
            </div>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-4">
            <button className="px-6 py-1.5 rounded-md font-bold text-sm bg-gradient-to-br from-primary-fixed to-primary-dim text-on-primary-fixed hover:opacity-90 transition-all">
              Export
            </button>
            <div className="w-8 h-8 rounded-full bg-surface-variant flex items-center justify-center border border-outline-variant/30">
              <span className="text-primary-fixed font-bold text-sm">S</span>
            </div>
          </div>
        </header>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">
          <EditorSidebar
            activeTab={activeTab}
            onTabChange={(newTab) => {
              navigate(`/editor/${id}/${newTab}`)
              dispatch({ type: 'SET_ACTIVE_TAB', payload: newTab })
            }}
          />
          <MainWorkspace audioOnly={state.audioOnly} isRoughCut={activeTab === 'roughcut'} />
        </div>
      </div>
    </EditorContext.Provider>
  )
}

/**
 * Main workspace with resizable splitter between video preview and bottom tools.
 * Drag the handle to resize — video preview grows/shrinks, timeline follows.
 */
function MainWorkspace({ audioOnly, isRoughCut }) {
  const [bottomH, setBottomH] = useState(350) // px — playback controls + timeline
  const dragging = useRef(false)
  const startY = useRef(0)
  const startH = useRef(0)

  const onMouseDown = useCallback((e) => {
    e.preventDefault()
    dragging.current = true
    startY.current = e.clientY
    startH.current = bottomH

    const onMove = (ev) => {
      const dy = startY.current - ev.clientY // dragging up = bigger bottom
      const newH = Math.max(160, Math.min(600, startH.current + dy))
      setBottomH(newH)
    }
    const onUp = () => {
      dragging.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [bottomH])

  return (
    <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden px-6">
      {/* Video preview — takes remaining space */}
      <div className="flex-1 flex flex-col min-h-0 pt-4">
        {isRoughCut ? (
          <div className="flex-1 flex gap-4 min-h-0">
            <div className="flex-1 bg-surface-container-low rounded-xl border border-white/5 overflow-hidden flex flex-col min-w-0">
              <TranscriptEditor />
            </div>
            <div className="w-[45%] shrink-0 flex flex-col min-h-0">
              <RoughCutPreview />
            </div>
          </div>
        ) : (
          <VideoPreviewGrid />
        )}
      </div>

      {/* Resizable splitter */}
      <div
        className="h-4 w-full flex items-center justify-center group relative z-40 shrink-0 cursor-ns-resize"
        onMouseDown={onMouseDown}
      >
        <div className="w-full h-px bg-white/5 group-hover:bg-primary-fixed/30 transition-colors" />
        <div className="absolute w-10 h-1 bg-outline-variant/50 rounded-full group-hover:bg-primary-fixed group-hover:shadow-[0_0_10px_rgba(206,252,0,0.5)] transition-all" />
      </div>

      {/* Bottom tools — fixed height, resizable via splitter */}
      <div className="flex flex-col gap-2 pb-4 shrink-0" style={{ height: `${bottomH}px` }}>
        <PlaybackControls />
        <div className="flex-1 min-h-0">
          <Timeline />
        </div>
      </div>
    </main>
  )
}

// Helper — derive tracks from timeline (used in INIT_TRACKS)
const STATUS_LABELS = {
  pending: 'Starting sync...',
  transcribing: 'Transcribing audio...',
  classifying: 'Classifying videos...',
  syncing: 'Analyzing transcripts...',
  building_timeline: 'Building timeline...',
  ordering: 'Ordering segments...',
  assembling: 'Assembling transcript...',
}

function SyncingScreen({ groupId, status, onDone }) {
  const [currentStatus, setCurrentStatus] = useState(status)

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/videos/groups/${groupId}/status`)
        const data = await res.json()
        setCurrentStatus(data.assembly_status)
        if (data.assembly_status === 'done' || data.assembly_status === 'error') {
          clearInterval(interval)
          onDone()
        }
      } catch {}
    }, 1500)
    return () => clearInterval(interval)
  }, [groupId, onDone])

  return (
    <div className="h-screen flex flex-col items-center justify-center bg-[#0e0e10] text-on-surface gap-6">
      <div className="relative">
        <span className="material-symbols-outlined animate-spin text-5xl text-primary-fixed">progress_activity</span>
      </div>
      <div className="flex flex-col items-center gap-2">
        <h2 className="text-lg font-bold text-on-surface">Syncing project</h2>
        <p className="text-sm text-on-surface-variant">{STATUS_LABELS[currentStatus] || currentStatus}</p>
      </div>
      <div className="flex gap-1 mt-2">
        {Object.keys(STATUS_LABELS).map(s => (
          <div key={s} className={`w-2 h-2 rounded-full transition-colors ${
            s === currentStatus ? 'bg-primary-fixed' :
            Object.keys(STATUS_LABELS).indexOf(s) < Object.keys(STATUS_LABELS).indexOf(currentStatus) ? 'bg-primary-fixed/40' :
            'bg-white/10'
          }`} />
        ))}
      </div>
    </div>
  )
}

function deriveFromTimeline(timeline, videos) {
  if (!timeline?.tracks?.length) return { tracks: [], groups: {} }
  const GROUP_COLORS = ['#cefc00', '#c180ff', '#65fde6', '#ff7351', '#48e5d0', '#dbb4ff']
  const vTracks = []
  const aTracks = []
  const groups = {}
  timeline.tracks.forEach((t, i) => {
    const color = GROUP_COLORS[i % GROUP_COLORS.length]
    const gId = `g-${t.videoId}`
    const video = videos?.find(v => v.id === t.videoId)
    groups[gId] = { color, trackIds: [`v-${t.videoId}`, `a-${t.videoId}`] }
    vTracks.push({
      id: `v-${t.videoId}`,
      type: 'video',
      videoId: t.videoId,
      title: video?.title || t.title || `Camera ${i + 1}`,
      offset: t.offset || 0,
      duration: t.duration || video?.duration_seconds || 0,
      groupId: gId,
      visible: true,
      originalOffset: t.offset || 0,
      filePath: video?.file_path || null,
      framesReady: video?.frames_status === 'done',
    })
    aTracks.push({
      id: `a-${t.videoId}`,
      type: 'audio',
      videoId: t.videoId,
      title: video?.title || t.title || `Camera ${i + 1}`,
      offset: t.offset || 0,
      duration: t.duration || video?.duration_seconds || 0,
      groupId: gId,
      muted: i > 0,
      waveform: t.waveform || [],
      waveformPeaks: t.waveformPeaks || [],
      transcriptWords: [],
      transcriptSentences: [],
      showTranscript: true,
      originalOffset: t.offset || 0,
    })
  })
  return { tracks: [...vTracks, ...aTracks], groups }
}
