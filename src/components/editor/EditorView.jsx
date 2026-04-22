import { createContext, useContext, useEffect, useLayoutEffect, useRef, useCallback, useState, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useApi, apiPost } from '../../hooks/useApi.js'
import { supabase } from '../../lib/supabaseClient.js'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
async function authFetch(path, opts = {}) {
  const headers = { ...opts.headers }
  if (supabase) {
    const { data } = await supabase.auth.getSession()
    if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`
  }
  return fetch(`${API_BASE}${path}`, { ...opts, headers })
}
import useEditorState from './useEditorState.js'
import EditorSidebar from './EditorSidebar.jsx'
import VideoPreviewGrid from './VideoPreviewGrid.jsx'
import PlaybackControls from './PlaybackControls.jsx'
import Timeline from './Timeline.jsx'
import TranscriptEditor from './TranscriptEditor.jsx'
import RoughCutPreview from './RoughCutPreview.jsx'
import AssetsView from './AssetsView.jsx'
import BRollPanel from './BRollPanel.jsx'
import EstimationModal from './EstimationModal.jsx'

export const EditorContext = createContext(null)

export default function EditorView() {
  const { id, tab, sub, detail } = useParams()
  const navigate = useNavigate()
  const { data: groupDetail, loading, error, refetch: refetchDetail } = useApi(`/videos/groups/${id}/detail`)
  const { data: wordTimestamps, refetch: refetchTimestamps } = useApi(`/videos/groups/${id}/word-timestamps`)
  const { state, dispatch, totalDuration, formatTime } = useEditorState()
  const [showRoughCutWarning, setShowRoughCutWarning] = useState(false)
  const [flowRunState, setFlowRunState] = useState(null)
  const cutDragRef = useRef(false) // true during cut edge drag — blocks AI cut regeneration
  // shape: { experimentId, runId, status: 'running'|'complete'|'error', progress: {...} }

  // Lightweight check: does this video have completed broll search (kw- pipeline)?
  const videoId = groupDetail?.videos?.[0]?.id
  const { data: videoRunsData } = useApi(videoId ? `/broll/runs/video/${videoId}` : null)
  const hasBrollSearch = useMemo(() => {
    if (!videoRunsData?.runs) return false
    const pipelineMap = {}
    for (const run of videoRunsData.runs) {
      try {
        const meta = JSON.parse(run.metadata_json || '{}')
        const pid = meta.pipelineId
        if (!pid) continue
        if (!pipelineMap[pid]) pipelineMap[pid] = { status: 'complete' }
        if (run.status === 'failed') pipelineMap[pid].status = 'failed'
      } catch {}
    }
    return Object.entries(pipelineMap).some(([pid, p]) => pid.startsWith('kw-') && p.status === 'complete')
  }, [videoRunsData])

  // Token system
  const [showEstimationModal, setShowEstimationModal] = useState(false)
  const [estimation, setEstimation] = useState(null)
  const [tokenBalance, setTokenBalance] = useState(null)
  const [estimationLoading, setEstimationLoading] = useState(false)

  // URL tab is source of truth — sync to state before paint
  const assetsStatuses = ['classifying', 'classified', 'classification_failed', 'confirmed']
  const activeTab = tab || (assetsStatuses.includes(groupDetail?.assembly_status) ? 'assets' : 'sync')
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

  // Load annotations from server (or clear stale ones if deleted)
  const defaultsAppliedRef = useRef(false)
  useEffect(() => {
    if (!state.groupId) return
    if (!groupDetail) return

    if (!groupDetail.annotations) {
      // Annotations were deleted on server — clear stale annotation cuts from restored state
      if (state.annotations) {
        dispatch({ type: 'SET_ANNOTATIONS', payload: null })
      }
      if (state.cuts.some(c => c.id.startsWith('cut-ai-ann-'))) {
        dispatch({ type: 'SET_AI_CUTS', payload: { prefix: 'cut-ai-ann-', cuts: [] } })
        dispatch({ type: 'SET_AI_CUTS', payload: { prefix: 'cut-ai-bridge-', cuts: [] } })
      }
      return
    }

    // Always sync annotations from server (picks up rebuilds after restart-from-stage)
    const serverCount = groupDetail.annotations.items?.length || 0
    const stateCount = state.annotations?.items?.length || 0
    if (!state.annotations || serverCount !== stateCount) {
      dispatch({ type: 'SET_ANNOTATIONS', payload: groupDetail.annotations })
    }
    // Auto-enable deletion categories once if none are enabled (first load)
    if (!defaultsAppliedRef.current && groupDetail.annotations.items?.length > 0) {
      const { false_starts, filler_words, meta_commentary } = state.aiCutsSelected || {}
      if (!false_starts && !filler_words && !meta_commentary) {
        applyConfigDefaults(groupDetail.rough_cut_config, dispatch)
      }
      defaultsAppliedRef.current = true
    }
  }, [groupDetail, state.groupId, state.annotations, state.cuts, state.aiCutsSelected, dispatch])

  // On roughcut load, seek to the first uncut position (skip leading cuts)
  // Only runs once — never overrides a manual seek
  const initialSeekDoneRef = useRef(false)
  useEffect(() => {
    if (activeTab !== 'roughcut' || initialSeekDoneRef.current) return
    if (!skipRegions.length) return
    initialSeekDoneRef.current = true
    if (skipRegions[0].start > 0.5) return
    // Only auto-seek if playhead is still at the beginning (user hasn't manually seeked)
    if (state.currentTime > 1.0) return
    let pos = 0
    for (const region of skipRegions) {
      if (region.start > pos + 0.05) break
      pos = Math.max(pos, region.end)
    }
    if (pos > 0.5) {
      dispatch({ type: 'SET_CURRENT_TIME', payload: pos })
    }
  }, [activeTab, state.cuts, dispatch])

  // Apply annotation defaults when entering roughcut tab with existing annotations
  useEffect(() => {
    if (activeTab !== 'roughcut' || !state.groupId) return
    if (groupDetail?.annotations?.items?.length > 0) {
      applyConfigDefaults(groupDetail.rough_cut_config, dispatch)
    }
  }, [activeTab, state.groupId, groupDetail, dispatch])

  // Poll flow progress
  useEffect(() => {
    if (!flowRunState?.experimentId || flowRunState.status !== 'running') return
    const interval = setInterval(async () => {
      try {
        const res = await authFetch(`/experiments/${flowRunState.experimentId}/progress`)
        if (!res.ok) {
          console.error('[flow-progress] Poll failed:', res.status, await res.text().catch(() => ''))
          return
        }
        const data = await res.json()
        const run = data.runs?.[0]
        console.log('[flow-progress] poll:', { status: run?.status, currentStage: run?.currentStage, totalStages: run?.totalStages, stagesLen: run?.stages?.length, segDone: run?.segmentsDone, segTotal: run?.segmentsTotal })
        if (run?.status === 'complete' || run?.status === 'partial') {
          clearInterval(interval)
          setFlowRunState(prev => ({ ...prev, status: 'complete', progress: data }))
          await refetchDetail()
        } else if (run?.status === 'failed') {
          clearInterval(interval)
          setFlowRunState(prev => ({ ...prev, status: 'error', progress: data }))
        } else {
          setFlowRunState(prev => ({ ...prev, progress: data }))
        }
      } catch (err) { console.error('[flow-progress] Poll error:', err) }
    }, 2500)
    return () => clearInterval(interval)
  }, [flowRunState?.experimentId, flowRunState?.status, refetchDetail])

  // Apply defaults when annotations arrive after flow completes
  useEffect(() => {
    if (flowRunState?.status !== 'complete') return
    if (!groupDetail?.annotations?.items?.length) return
    if (!state.annotations) {
      dispatch({ type: 'SET_ANNOTATIONS', payload: groupDetail.annotations })
    }
    applyConfigDefaults(groupDetail.rough_cut_config, dispatch)
    setFlowRunState(null)
  }, [flowRunState?.status, groupDetail, state.annotations, dispatch])


  // Trigger server-side frame extraction for existing projects that don't have frames yet
  useEffect(() => {
    if (!groupDetail?.videos) return
    const needsFrames = groupDetail.videos.some(v => v.frames_status !== 'done' && v.frames_status !== 'extracting')
    if (needsFrames) {
      authFetch(`/videos/groups/${id}/extract-frames`, { method: 'POST' }).catch(() => {})
    }
  }, [groupDetail, id])

  // Auto-generate timeline with waveforms if missing
  const timelineGenRef = useRef(false)
  useEffect(() => {
    if (!groupDetail || timelineGenRef.current) return
    if (groupDetail.timeline) return // already has timeline
    if (!groupDetail.videos?.length) return
    timelineGenRef.current = true
    console.log('[editor] No timeline — generating waveforms...')
    authFetch(`/videos/groups/${id}/generate-timeline`, { method: 'POST' })
      .then(r => r.json())
      .then(() => { refetchDetail() })
      .catch(err => console.error('[editor] Timeline generation failed:', err))
  }, [groupDetail, id, refetchDetail])

  // Fetch token balance on mount
  useEffect(() => {
    authFetch('/videos/user/tokens')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (typeof d?.balance === 'number') setTokenBalance(d.balance) })
      .catch(() => {})
  }, [])

  // Handler: open estimation modal
  const handleStartAIRoughCut = useCallback(async () => {
    if (!state.groupId) return
    setEstimationLoading(true)
    try {
      const res = await authFetch(`/videos/groups/${state.groupId}/estimate-ai-roughcut`, { method: 'POST' })
      const data = await res.json()
      setEstimation(data)
      setShowEstimationModal(true)
    } catch (err) {
      console.error('[estimate] Failed:', err)
    } finally {
      setEstimationLoading(false)
    }
  }, [state.groupId])

  // Handler: accept estimation and start pipeline
  const handleAcceptAIRoughCut = useCallback(async () => {
    if (!state.groupId) return
    setEstimationLoading(true)
    try {
      const res = await authFetch(`/videos/groups/${state.groupId}/start-ai-roughcut`, { method: 'POST' })
      const data = await res.json()
      if (data.error === 'insufficient_tokens') {
        setEstimation(prev => ({ ...prev, sufficient: false, balance: data.balance }))
        setEstimationLoading(false)
        return
      }
      setShowEstimationModal(false)
      setEstimation(null)
      if (data.balanceAfter != null) setTokenBalance(data.balanceAfter)
      if (data.already_exists) {
        await refetchDetail()
      } else if (data.experimentId) {
        setFlowRunState({
          experimentId: data.experimentId,
          runId: data.runId,
          status: 'running',
          progress: null,
          totalStages: data.totalStages || 0,
          stageNames: data.stageNames || [],
          stageTypes: data.stageTypes || [],
        })
      }
    } catch (err) {
      console.error('[start-ai-roughcut] Failed:', err)
    } finally {
      setEstimationLoading(false)
    }
  }, [state.groupId, refetchDetail])

  // Load word timestamps — re-runs when tracks reference changes (e.g. after INIT_TRACKS)
  // to handle the case where timestamps loaded before tracks were populated,
  // or INIT_TRACKS rebuilt tracks and wiped transcriptWords.
  useEffect(() => {
    if (!wordTimestamps || !state.groupId || state.tracks.length === 0) return
    // Only apply if some audio track is missing words
    const needsWords = state.tracks.some(t => t.type === 'audio' && wordTimestamps[t.videoId] && !t.transcriptWords?.length)
    if (!needsWords) return
    dispatch({ type: 'SET_WORD_TIMESTAMPS', payload: { wordTimestamps } })
  }, [wordTimestamps, state.groupId, state.tracks, dispatch])

  // Build refined skip regions for playback (same merge + waveform logic as Timeline's mergedDisplayCuts)
  const skipRegions = useMemo(() => {
    if (state.activeTab !== 'roughcut' || !state.cuts.length) return []
    const primaryAudio = state.tracks
      .filter(t => t.type === 'audio' && t.transcriptWords?.length)
      .sort((a, b) => b.duration - a.duration)[0]
    const words = primaryAudio?.transcriptWords?.map(w => ({
      start: w.start + (primaryAudio.offset || 0),
      end: w.end + (primaryAudio.offset || 0),
    })) || []
    const peaks = primaryAudio?.waveformPeaks
    const offset = primaryAudio?.offset || 0

    const valid = state.cuts.filter(c => c.end > c.start + 0.01)
    if (!valid.length) return []
    const sorted = [...valid].sort((a, b) => a.start - b.start)
    const merged = [{ ...sorted[0] }]
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1]
      if (sorted[i].start <= last.end + 0.05) {
        last.end = Math.max(last.end, sorted[i].end)
      } else {
        const hasWord = words.some(w => w.start >= last.end - 0.05 && w.end <= sorted[i].start + 0.05)
        if (!hasWord) {
          last.end = Math.max(last.end, sorted[i].end)
        } else {
          merged.push({ ...sorted[i] })
        }
      }
    }

    if (peaks?.length) {
      const PEAKS_PER_SEC = 100
      const timeToPeak = (t) => Math.round((t - offset) * PEAKS_PER_SEC)
      const hasSound = (b) => {
        if (b < 0 || b * 2 + 1 >= peaks.length) return false
        const linear = Math.abs(peaks[b * 2 + 1]) / 128
        if (linear <= 0) return false
        return (20 * Math.log10(linear) + 60) / 60 >= 0.5 / 56
      }
      for (const region of merged) {
        const prevWord = [...words].reverse().find(w => w.end <= region.start + 0.05 &&
          !merged.some(c => w.start >= c.start - 0.05 && w.end <= c.end + 0.05))
        if (prevWord) {
          const origStart = region.start
          const wordEndBar = timeToPeak(prevWord.end)
          const wordStartBar = timeToPeak(prevWord.start)
          if (hasSound(wordEndBar)) {
            let b = wordEndBar
            const maxBar = timeToPeak(origStart)
            while (b < maxBar && hasSound(b)) b++
            region.start = Math.min(origStart, offset + b / PEAKS_PER_SEC + 0.1)
          } else {
            let b = wordEndBar
            while (b > wordStartBar && !hasSound(b)) b--
            if (hasSound(b)) region.start = Math.min(origStart, offset + (b + 1) / PEAKS_PER_SEC + 0.15)
          }
        }
        const nextWord = words.find(w => w.start >= region.end - 0.05 &&
          !merged.some(c => w.start >= c.start - 0.05 && w.end <= c.end + 0.05))
        if (nextWord) {
          const origEnd = region.end
          const wordStartBar = timeToPeak(nextWord.start)
          if (hasSound(wordStartBar)) {
            let b = wordStartBar
            const scanLimit = wordStartBar - 50
            while (b > scanLimit) {
              if (!hasSound(b) && !hasSound(b - 1) && !hasSound(b - 2)) break
              b--
            }
            region.end = Math.max(origEnd, offset + (b + 1) / PEAKS_PER_SEC - 0.05)
          } else {
            let b = wordStartBar
            const limit = wordStartBar + 50
            while (b < limit) {
              if (hasSound(b) && hasSound(b + 1) && hasSound(b + 2)) {
                region.end = Math.max(origEnd, offset + b / PEAKS_PER_SEC - 0.05)
                break
              }
              b++
            }
          }
        }
        if (region.end <= region.start) region.end = region.start + 0.01
      }
    }
    // Split merged regions around manual exclusions — these always take priority
    const exclusions = state.cutExclusions || []
    if (exclusions.length > 0) {
      const split = []
      for (const region of merged) {
        let current = { ...region }
        for (const ex of [...exclusions].sort((a, b) => a.start - b.start)) {
          if (ex.start >= current.end || ex.end <= current.start) continue
          if (current.start < ex.start - 0.01) {
            split.push({ start: current.start, end: ex.start })
          }
          current.start = ex.end
        }
        if (current.start < current.end - 0.01) {
          split.push(current)
        }
      }
      // Re-add manual/split cuts — these always skip regardless of exclusions
      const manualCuts = state.cuts.filter(c => c.end > c.start + 0.01 && (c.source === 'manual' || c.source === 'split'))
      for (const mc of manualCuts) {
        // Only add if not already covered by an existing split region
        const alreadyCovered = split.some(r => r.start <= mc.start && r.end >= mc.end)
        if (!alreadyCovered) split.push({ start: mc.start, end: mc.end })
      }
      split.sort((a, b) => a.start - b.start)
      return split
    }
    return merged
  }, [state.activeTab, state.cuts, state.cutExclusions, state.tracks])
  const skipRegionsRef = useRef(skipRegions)
  skipRegionsRef.current = skipRegions

  // Mirror all state values that tick reads, so tick's useCallback deps can be empty
  // and the rAF loop doesn't restart on every unrelated state change.
  const stateRefs = useRef({
    tracks: state.tracks,
    playbackRate: state.playbackRate,
    zoom: state.zoom,
    volume: state.volume,
    activeTab: state.activeTab,
    roughCutTrackMode: state.roughCutTrackMode,
    segmentVideoOverrides: state.segmentVideoOverrides,
    segmentAudioOverrides: state.segmentAudioOverrides,
    totalDuration,
  })
  stateRefs.current.tracks = state.tracks
  stateRefs.current.playbackRate = state.playbackRate
  stateRefs.current.zoom = state.zoom
  stateRefs.current.volume = state.volume
  stateRefs.current.activeTab = state.activeTab
  stateRefs.current.roughCutTrackMode = state.roughCutTrackMode
  stateRefs.current.segmentVideoOverrides = state.segmentVideoOverrides
  stateRefs.current.segmentAudioOverrides = state.segmentAudioOverrides
  stateRefs.current.totalDuration = totalDuration

  // Declared before tick so tick's deps can include stopAllVideos without TDZ.
  const stopAllVideos = useCallback(() => {
    Object.values(videoRefs.current).forEach(el => {
      if (el && !el.paused) el.pause()
      if (el) el.muted = true
    })
  }, [])

  // Playback engine (rAF loop) — media-driven clock
  // Uses the master video element's currentTime as the time source instead of
  // performance.now(). This avoids constant seeking when audio output is buffered
  // (e.g. Bluetooth speakers add 100-300ms latency that desync wall clock from media time).
  const tick = useCallback(() => {
    const now = performance.now()
    const s = stateRefs.current
    const videoTracks = s.tracks.filter(t => t.type === 'video')

    // Find master element: prefer unmuted active track, fall back to any playing track
    let masterEl = null
    let masterTrack = null
    for (const track of videoTracks) {
      const el = videoRefs.current[track.videoId]
      if (!el || el.paused || el.readyState < 2) continue
      const audioTrack = s.tracks.find(t => t.type === 'audio' && t.videoId === track.videoId)
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
        newTime = startPlayheadTime.current + elapsed * s.playbackRate
      }
    }

    // Stop at end
    if (newTime >= s.totalDuration) {
      dispatch({ type: 'SET_CURRENT_TIME', payload: s.totalDuration })
      dispatch({ type: 'PAUSE' })
      stopAllVideos()
      return
    }

    // Skip cut regions in rough cut mode (using waveform-refined regions)
    const regions = skipRegionsRef.current
    if (s.activeTab === 'roughcut' && regions.length > 0) {
      const preSkipTime = newTime
      let skipping = true
      while (skipping) {
        skipping = false
        for (const region of regions) {
          if (newTime >= region.start && newTime < region.end) {
            newTime = region.end
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
        if (newTime >= s.totalDuration) {
          dispatch({ type: 'SET_CURRENT_TIME', payload: s.totalDuration })
          dispatch({ type: 'PAUSE' })
          stopAllVideos()
          return
        }
      }
    }

    // In Main Track mode, find the active videoId at the current time
    // (the video whose segment covers the playhead — same logic as composite track)
    const isMainMode = s.activeTab === 'roughcut' && s.roughCutTrackMode === 'main'
    let mainActiveVideoId = null
    let mainActiveAudioId = null
    let mainSegIdx = -1
    if (isMainMode) {
      // Build merged segments (same logic as mainTrackSegments in Timeline)
      const sorted = [...videoTracks].sort((a, b) => a.offset - b.offset)
      const segments = []
      let cur = null
      for (const t of sorted) {
        const tEnd = t.offset + t.duration
        if (cur && t.offset < cur.end) {
          cur.end = Math.max(cur.end, tEnd)
        } else {
          cur = { start: t.offset, end: tEnd, videoId: t.videoId }
          segments.push(cur)
        }
      }
      // Search backwards: find the last segment whose start <= newTime
      if (segments.length) {
        for (let i = segments.length - 1; i >= 0; i--) {
          if (newTime >= segments[i].start) {
            mainActiveVideoId = segments[i].videoId
            mainSegIdx = i
            break
          }
        }
        if (!mainActiveVideoId) {
          mainActiveVideoId = segments[0].videoId
          mainSegIdx = 0
        }
      }

      // Apply video override
      if (mainSegIdx >= 0) {
        const vidOv = s.segmentVideoOverrides[mainSegIdx]
        if (vidOv) {
          const ovTrack = videoTracks.find(t => t.videoId === vidOv)
          if (ovTrack && newTime >= ovTrack.offset && newTime < ovTrack.offset + ovTrack.duration) {
            mainActiveVideoId = vidOv
          }
        }
      }

      // Audio override (independent of video)
      mainActiveAudioId = mainActiveVideoId
      if (mainSegIdx >= 0) {
        const audioOv = s.segmentAudioOverrides[mainSegIdx]
        if (audioOv) {
          const ovTrack = videoTracks.find(t => t.videoId === audioOv)
          if (ovTrack && newTime >= ovTrack.offset && newTime < ovTrack.offset + ovTrack.duration) {
            mainActiveAudioId = audioOv
          }
        }
      }
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
        el.playbackRate = s.playbackRate

        const audioTrack = s.tracks.find(t => t.type === 'audio' && t.videoId === track.videoId)
        // Audio: in Main Track mode, only unmute the active segment's video.
        // In All Tracks mode, unmute per the track's mute setting.
        if (isMainMode) {
          if (track.videoId === mainActiveAudioId) {
            el.muted = false
            el.volume = s.volume
          } else {
            el.muted = true
          }
        } else if (audioTrack && !audioTrack.muted) {
          el.muted = false
          el.volume = s.volume
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
      const x = newTime * s.zoom
      playheadRef.current.style.transform = `translateX(${x}px)`
    }

    // Throttle state update to ~10Hz
    if (now - throttleRef.current > 100) {
      throttleRef.current = now
      dispatch({ type: 'SET_CURRENT_TIME', payload: newTime })
    }

    rafId.current = requestAnimationFrame(tick)
  }, [dispatch, stopAllVideos])

  // Start/stop rAF based on isPlaying
  useEffect(() => {
    if (state.isPlaying) {
      // Seed the rAF baseline from the current state at the moment play begins.
      // This runs only on play-toggle, not on every tick-recreation.
      startRealTime.current = performance.now()
      startPlayheadTime.current = state.currentTime
      rafId.current = requestAnimationFrame(tick)
    } else {
      cancelAnimationFrame(rafId.current)
      stopAllVideos()
    }
    return () => cancelAnimationFrame(rafId.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isPlaying]) // tick is stable now (deps: dispatch + stopAllVideos, both stable); state.currentTime only read on play-start

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
      } else if ((e.code === 'Backspace' || e.code === 'Delete') && state.activeTab === 'roughcut') {
        if (state.transcriptSelection) {
          e.preventDefault()
          const { startTime, endTime, words } = state.transcriptSelection
          // Count cut vs uncut words/pauses in the selection
          const items = words || []
          let cutCount = 0
          let uncutCount = 0
          for (const w of items) {
            const wEnd = w.end || w.start + 0.01
            const isCut = state.cuts.some(c => w.start < c.end && wEnd > c.start)
            if (isCut) cutCount++
            else uncutCount++
          }
          // If no word info, fall back to overlap check
          if (items.length === 0) {
            const overlapping = state.cuts.filter(c => c.start < endTime && c.end > startTime)
            if (overlapping.length > 0) cutCount = 1
            else uncutCount = 1
          }
          const action = cutCount > uncutCount ? 'UNCUT' : 'CUT'
          console.log(`[roughcut] Backspace: ${startTime.toFixed(2)}-${endTime.toFixed(2)} | items=${items.length} cut=${cutCount} uncut=${uncutCount} → ${action}`)
          if (action === 'UNCUT') {
            dispatch({ type: 'EXCLUDE_FROM_CUT', payload: { wordStart: startTime, wordEnd: endTime } })
            // Also remove any manual cuts that overlap the selection
            const withoutManual = state.cuts.filter(c => c.source === 'transcript' && startTime < c.end && endTime > c.start ? false : true)
            if (withoutManual.length !== state.cuts.length) {
              for (const c of state.cuts) {
                if (c.source === 'transcript' && startTime < c.end && endTime > c.start) {
                  dispatch({ type: 'REMOVE_CUT', payload: c.id })
                }
              }
            }
          } else {
            // Remove any exclusions that overlap the selection (re-enables annotation cuts)
            const remaining = state.cutExclusions.filter(e => !(startTime < e.end + 0.01 && endTime > e.start - 0.01))
            if (remaining.length !== state.cutExclusions.length) {
              dispatch({ type: 'SET_EXCLUSIONS', payload: remaining })
            }
            dispatch({
              type: 'ADD_CUT',
              payload: { id: `cut-${Date.now()}`, start: startTime, end: endTime, source: 'transcript' },
            })
          }
          dispatch({ type: 'SET_TRANSCRIPT_SELECTION', payload: null })
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [state.isPlaying, state.currentTime, state.activeTab, state.transcriptSelection, totalDuration, dispatch])

  const editorContextValue = useMemo(
    () => ({ state, dispatch, videoRefs, playbackEngine, playheadRef, totalDuration, formatTime, refetchDetail, refetchTimestamps, flowRunState, cutDragRef, tokenBalance, handleStartAIRoughCut, estimationLoading }),
    [state, dispatch, totalDuration, formatTime, refetchDetail, refetchTimestamps, flowRunState, tokenBalance, handleStartAIRoughCut, estimationLoading]
  )

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
  const isAssembling = assemblyStatus && !['done', 'error', 'classifying', 'classified', 'classification_failed', 'confirmed'].includes(assemblyStatus)
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
    <EditorContext.Provider value={editorContextValue}>
      <div className="h-screen flex flex-col overflow-hidden bg-[#0e0e10] text-on-surface font-['Inter',sans-serif]">
        {/* Top nav */}
        <header className="flex justify-between items-center w-full px-6 h-14 bg-[#0e0e10] z-50 shrink-0">
          <div className="flex items-center gap-8">
            <span className="text-primary-fixed font-bold text-lg tracking-tight">Studio</span>
            <div className="flex items-center gap-6 h-full pl-4">
              <Link to="/" className="text-on-surface/60 hover:text-on-surface font-bold text-sm transition-colors">Projects</Link>
              <div className="relative flex flex-col items-center justify-center">
                <span className="text-primary-fixed font-bold text-sm">Editor</span>
                <div className="w-full h-0.5 bg-primary-fixed shadow-[0_0_8px_rgba(206,252,0,0.4)] mt-1" />
              </div>
            </div>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-4">
            {tokenBalance != null && (
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-md bg-white/5 border border-white/10">
                <span className="material-symbols-outlined text-sm text-secondary">token</span>
                <span className="text-xs font-bold text-on-surface-variant">{tokenBalance.toLocaleString()}</span>
              </div>
            )}
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
            activeSub={sub}
            assemblyStatus={groupDetail?.assembly_status}
            hasVideos={groupDetail?.videos?.length > 0}
            hasBrollSearch={hasBrollSearch}
            onTabChange={(newTab) => {
              // Warn when leaving roughcut with progress
              const hasRoughCutProgress = state.cuts.length > 0 || Object.keys(state.segmentVideoOverrides).length > 0 || Object.keys(state.segmentAudioOverrides).length > 0
              if (state.activeTab === 'roughcut' && newTab === 'sync' && hasRoughCutProgress) {
                setShowRoughCutWarning(true)
                return
              }
              navigate(`/editor/${id}/${newTab}`)
              const tabKey = newTab.split('/')[0]
              dispatch({ type: 'SET_ACTIVE_TAB', payload: tabKey })
            }}
          />
          {activeTab === 'assets' ? (
            <AssetsView />
          ) : activeTab === 'brolls' ? (
            <BRollPanel groupId={Number(id)} videoId={groupDetail?.videos?.[0]?.id} sub={sub} detail={detail} />
          ) : (
            <MainWorkspace audioOnly={state.audioOnly} isRoughCut={activeTab === 'roughcut'} isMainMode={activeTab === 'roughcut' && state.roughCutTrackMode === 'main'} />
          )}
        </div>
      </div>

      {/* Rough Cut → Sync confirmation modal */}
      {showRoughCutWarning && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm px-6">
          <div className="max-w-md w-full rounded-xl overflow-hidden shadow-2xl shadow-black/60 border border-outline-variant/20" style={{ background: 'rgba(25, 25, 28, 0.7)', backdropFilter: 'blur(20px)' }}>
            <div className="px-8 pt-8 pb-4">
              <div className="w-12 h-12 bg-error-container/20 rounded-full flex items-center justify-center mb-6">
                <span className="material-symbols-outlined text-error text-2xl">warning</span>
              </div>
              <h2 className="font-['Manrope'] text-3xl font-extrabold tracking-tight text-on-surface mb-3">Lose Rough Cut Progress?</h2>
              <p className="text-on-surface-variant leading-relaxed">
                If you continue, you will lose all your progress in <span className="text-primary-fixed font-semibold">Rough Cut</span>. Are you sure you want to go back to <span className="text-secondary font-semibold">Sync</span>?
              </p>
            </div>
            <div className="p-8 space-y-3">
              <button
                onClick={() => {
                  dispatch({ type: 'CLEAR_ROUGH_CUT' })
                  setShowRoughCutWarning(false)
                  navigate(`/editor/${id}/sync`)
                  dispatch({ type: 'SET_ACTIVE_TAB', payload: 'sync' })
                }}
                className="w-full flex items-center justify-center gap-2 py-4 bg-error text-on-error font-bold rounded-lg hover:bg-error-dim transition-colors active:scale-95 duration-150"
              >
                <span className="material-symbols-outlined text-xl">delete_forever</span>
                Delete progress and go to sync
              </button>
              <button
                onClick={() => setShowRoughCutWarning(false)}
                className="w-full py-4 text-on-surface font-semibold hover:bg-surface-bright/40 rounded-lg transition-all duration-200 active:scale-95"
              >
                No, continue editing
              </button>
            </div>
            <div className="h-1 w-full bg-gradient-to-r from-transparent via-error/20 to-transparent" />
          </div>
        </div>
      )}

      {/* AI Rough Cut estimation modal */}
      {showEstimationModal && estimation && (
        <EstimationModal
          estimation={estimation}
          onAccept={handleAcceptAIRoughCut}
          onDecline={() => { setShowEstimationModal(false); setEstimation(null) }}
          loading={estimationLoading}
        />
      )}
    </EditorContext.Provider>
  )
}

/**
 * Main workspace with resizable splitter between video preview and bottom tools.
 * Drag the handle to resize — video preview grows/shrinks, timeline follows.
 */
function MainWorkspace({ audioOnly, isRoughCut, isMainMode }) {
  const { flowRunState } = useContext(EditorContext)
  const [bottomH, setBottomH] = useState(isMainMode ? 310 : 350) // px — playback controls + timeline
  const [videoW, setVideoW] = useState(45) // % width of video preview panel (rough cut)
  const prevMainMode = useRef(isMainMode)
  useEffect(() => {
    if (prevMainMode.current !== isMainMode) {
      prevMainMode.current = isMainMode
      setBottomH(isMainMode ? 310 : 350)
    }
  }, [isMainMode])
  const dragging = useRef(false)
  const startY = useRef(0)
  const startH = useRef(0)
  const splitRef = useRef(null)

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

  const onSplitMouseDown = useCallback((e) => {
    e.preventDefault()
    const containerW = splitRef.current?.getBoundingClientRect().width || 1
    const startX = e.clientX
    const startW = videoW

    const onMove = (ev) => {
      const dx = ev.clientX - startX // dragging right = transcript bigger, video smaller
      const newW = Math.max(20, Math.min(75, startW - (dx / containerW) * 100))
      setVideoW(newW)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [videoW])

  // Full-screen flow progress — replaces entire workspace
  if (isRoughCut && (flowRunState?.status === 'running' || flowRunState?.status === 'error' || flowRunState?.status === 'blocked')) {
    return (
      <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden">
        {flowRunState.status === 'blocked' ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md space-y-3">
              <div className="w-10 h-10 rounded-full bg-red-900/30 border border-red-800 flex items-center justify-center mx-auto">
                <span className="text-red-400 text-lg">!</span>
              </div>
              <h3 className="text-sm font-medium text-zinc-200">Analysis failed</h3>
              <p className="text-xs text-zinc-400">{flowRunState.message}</p>
            </div>
          </div>
        ) : (
          <FlowProgressScreen progress={flowRunState.progress} initialTotalStages={flowRunState.totalStages} initialStageNames={flowRunState.stageNames} initialStageTypes={flowRunState.stageTypes || []} error={flowRunState.status === 'error'} onDismissError={() => setFlowRunState(null)} />
        )}
      </main>
    )
  }

  return (
    <main className="flex-1 flex flex-col bg-surface-dim overflow-hidden px-6">
      {/* Video preview — takes remaining space */}
      <div className="flex-1 flex flex-col min-h-0 pt-4">
        {isRoughCut ? (
          <div ref={splitRef} className="flex-1 flex min-h-0">
            <div className="flex-1 bg-surface-container-low rounded-xl border border-white/5 overflow-hidden flex flex-col min-w-0">
              <TranscriptEditor />
            </div>
            {/* Vertical splitter — transcript / video preview */}
            <div
              className="w-4 shrink-0 flex items-center justify-center group relative z-40 cursor-ew-resize"
              onMouseDown={onSplitMouseDown}
            >
              <div className="h-full w-px bg-white/5 group-hover:bg-primary-fixed/30 transition-colors" />
              <div className="absolute h-10 w-1 bg-outline-variant/50 rounded-full group-hover:bg-primary-fixed group-hover:shadow-[0_0_10px_rgba(206,252,0,0.5)] transition-all" />
            </div>
            <div style={{ width: `${videoW}%` }} className="shrink-0 flex flex-col min-h-0">
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
        const res = await authFetch(`/videos/groups/${groupId}/status`)
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

function applyConfigDefaults(config, dispatch) {
  // When no config exists, default all deletion categories ON — the LLM found
  // things to cut, so they should be applied as cuts by default
  dispatch({ type: 'SET_AI_CUTS_SELECTED', payload: {
    false_starts: config?.false_starts ?? true,
    filler_words: config?.filler_words ?? true,
    meta_commentary: config?.meta_commentary ?? true,
  }})
  dispatch({ type: 'SET_AI_IDENTIFY_SELECTED', payload: {
    repetition: config?.repetition ?? true,
    lengthy: config?.lengthy ?? false,
    technical_unclear: config?.technical_unclear ?? false,
    irrelevance: config?.irrelevance ?? false,
  }})
}

function FlowProgressScreen({ progress, initialTotalStages = 0, initialStageNames = [], initialStageTypes = [], error = false, onDismissError }) {
  const run = progress?.runs?.[0]
  const totalStages = run?.totalStages || initialTotalStages
  // Use in-memory live progress, or fall back to DB completed stages count
  const dbCompletedStages = run?.stages?.length || 0
  const currentStage = run?.currentStage ?? (dbCompletedStages > 0 ? dbCompletedStages : (run ? 0 : -1))

  if (error) {
    const errorMsg = run?.error_message || run?.errorMessage || 'Unknown error'
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-6">
        <span className="material-symbols-outlined text-5xl text-red-400">error</span>
        <h2 className="text-lg font-bold text-on-surface">Analysis failed</h2>
        <p className="text-sm text-on-surface-variant max-w-md text-center">{errorMsg}</p>
        <button onClick={onDismissError} className="px-5 py-2.5 text-sm rounded-lg bg-white/5 hover:bg-white/10 text-on-surface-variant transition-colors">
          Continue to editor
        </button>
      </div>
    )
  }

  // Compute weighted percentage
  // llm_parallel = 10 weight (heavy), llm/llm_question = 3, programmatic = 1 (instant)
  const WEIGHTS = { llm_parallel: 10, llm: 3, llm_question: 3, programmatic: 1 }
  const stageWeights = Array.from({ length: totalStages }, (_, i) => WEIGHTS[initialStageTypes[i]] || 3)
  const totalWeight = stageWeights.reduce((a, b) => a + b, 0) || 1

  let completedWeight = 0
  for (let i = 0; i < totalStages; i++) {
    if (currentStage >= 0 && i < currentStage) {
      completedWeight += stageWeights[i]
    } else if (currentStage >= 0 && i === currentStage) {
      // Partial progress within current stage
      if (run?.segmentsTotal > 1) {
        completedWeight += stageWeights[i] * ((run.segmentsDone || 0) / run.segmentsTotal)
      }
    }
  }
  const percent = Math.min(99, Math.round((completedWeight / totalWeight) * 100))

  // Current stage name
  const currentName = currentStage >= 0
    ? (run?.stageName || initialStageNames[currentStage] || `Stage ${currentStage + 1}`)
    : ''
  const currentDetail = currentStage >= 0 && run?.segmentsTotal > 1
    ? `${run.segmentsDone || 0}/${run.segmentsTotal} segments`
    : ''

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6">
      {/* Headline */}
      <div className="text-sm text-on-surface-variant">Please wait</div>

      {/* Percentage */}
      <div className="relative flex items-center justify-center">
        <span className="text-6xl font-bold text-primary-fixed tabular-nums">{percent}</span>
        <span className="text-2xl font-bold text-primary-fixed/50 ml-1">%</span>
      </div>

      {/* Progress bar */}
      <div className="w-72 h-1.5 bg-white/5 rounded-full overflow-hidden">
        <div
          className="h-full bg-primary-fixed rounded-full transition-all duration-700 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function deriveFromTimeline(timeline, videos) {
  // Single-video fallback: synthesize a timeline from the video list
  if (!timeline?.tracks?.length && videos?.length) {
    timeline = {
      tracks: videos.map(v => ({
        videoId: v.id,
        title: v.title,
        offset: 0,
        duration: v.duration_seconds || 0,
      })),
    }
  }
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
      cfStreamUid: video?.cf_stream_uid || null,
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
  return { tracks: [...aTracks, ...vTracks], groups }
}
