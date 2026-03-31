import { useReducer, useEffect, useRef, useCallback } from 'react'
import { apiPut } from '../../hooks/useApi.js'

const GROUP_COLORS = ['#cefc00', '#c180ff', '#65fde6', '#ff7351', '#48e5d0', '#dbb4ff']

function formatTime(s) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function formatTimeRuler(s, majorInterval) {
  const m = Math.floor(s / 60)
  const sec = s % 60
  if (majorInterval >= 1) {
    // MM:SS
    return `${String(m).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')}`
  }
  // MM:SS.ff (centiseconds — dot separates fractional part)
  const whole = Math.floor(sec)
  const frac = Math.round((sec - whole) * 100)
  return `${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(frac).padStart(2, '0')}`
}

function buildSentences(words) {
  if (!words?.length) return []
  const sentences = []
  let sentStart = 0
  for (let i = 0; i < words.length; i++) {
    const word = words[i].word || ''
    const isLast = i === words.length - 1
    const endsPunct = /[.!?]["'"')\]]?\s*$/.test(word)
    const hasGap = !isLast && (words[i + 1].start - words[i].end) > 1.0
    if (endsPunct || hasGap || isLast) {
      sentences.push({
        text: words.slice(sentStart, i + 1).map(w => w.word).join(' '),
        start: words[sentStart].start,
        end: words[i].end,
        firstWord: sentStart,
        lastWord: i,
      })
      sentStart = i + 1
    }
  }
  return sentences
}

function deriveTracksFromTimeline(timeline, videos) {
  if (!timeline?.tracks?.length) return { tracks: [], groups: {} }
  const tracks = []
  const groups = {}
  timeline.tracks.forEach((t, i) => {
    const color = GROUP_COLORS[i % GROUP_COLORS.length]
    const gId = `g-${t.videoId}`
    const video = videos?.find(v => v.id === t.videoId)
    groups[gId] = { color, trackIds: [`v-${t.videoId}`, `a-${t.videoId}`] }
    tracks.push({
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
    })
    tracks.push({
      id: `a-${t.videoId}`,
      type: 'audio',
      videoId: t.videoId,
      title: video?.title || t.title || `Camera ${i + 1}`,
      offset: t.offset || 0,
      duration: t.duration || video?.duration_seconds || 0,
      groupId: gId,
      muted: i > 0,
      waveform: t.waveform || [],
      transcriptWords: [],
      transcriptSentences: [],
      showTranscript: false,
      originalOffset: t.offset || 0,
    })
  })
  return { tracks, groups }
}


const initialState = {
  groupId: null,
  groupDetail: null,
  tracks: [],
  groups: {},
  originalVideoOrder: [], // stable V/A numbering — set once on INIT_TRACKS, never changes on reorder
  selectedTrackIds: new Set(),
  currentTime: 0,
  isPlaying: false,
  playbackRate: 1,
  zoom: 50,
  audioOnly: false,
  volume: 0.7,
  contextMenu: null,
  isDirty: false,
  activeTab: 'sync',
  cuts: [],          // [{id, start, end, source: 'transcript'}]
  cutExclusions: [], // [{start, end}] — words manually excluded from annotation cuts
  aiCutsSelected: { silences: false, false_starts: false, filler_words: false, meta_commentary: false },
  aiIdentifySelected: { repetition: false, lengthy: false, technical_unclear: false, irrelevance: false },
  roughCutTrackMode: 'main', // 'main' = single composite track, 'all' = individual tracks
  compositeShowTranscript: false,
  syncTranscriptState: null,      // stashed per-track showTranscript for sync mode
  roughcutTranscriptState: null,  // stashed compositeShowTranscript for roughcut mode
  transcriptSelection: null, // {startTime, endTime} — set by TranscriptEditor, read by EditorView for Backspace cut
  segmentVideoOverrides: {},  // { [segmentIndex]: videoId }
  segmentAudioOverrides: {},  // { [segmentIndex]: videoId }
  annotations: null,          // loaded from server, not serialized
}

function cascadeOverlaps(tracks) {
  // Build group units: { id, indices[], start, end }
  const unitMap = new Map()
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    const unitId = t.groupId || t.id
    if (!unitMap.has(unitId)) {
      unitMap.set(unitId, { id: unitId, indices: [], start: Infinity, end: -Infinity })
    }
    const u = unitMap.get(unitId)
    u.indices.push(i)
    u.start = Math.min(u.start, t.offset)
    u.end = Math.max(u.end, t.offset + t.duration)
  }
  // Sort by start, sweep, push overlapping units right
  const units = [...unitMap.values()].sort((a, b) => a.start - b.start)
  const result = [...tracks]
  let prevEnd = -Infinity
  for (const u of units) {
    if (u.start < prevEnd) {
      const delta = prevEnd - u.start
      for (const idx of u.indices) {
        result[idx] = { ...result[idx], offset: result[idx].offset + delta }
      }
      u.start += delta
      u.end += delta
    }
    prevEnd = Math.max(prevEnd, u.end)
  }
  return result
}

function reducer(state, action) {
  switch (action.type) {
    case 'INIT_TRACKS': {
      const { tracks, groups, groupDetail, groupId, restoredState } = action.payload
      // Stable numbering: use fresh track order (from timeline), never changes on reorder
      const originalVideoOrder = tracks.filter(t => t.type === 'video').map(t => t.id)
      if (restoredState) {
        // Merge fresh waveform data into restored tracks (waveforms aren't saved in editor state)
        const freshById = Object.fromEntries(tracks.map(t => [t.id, t]))
        const mergedTracks = (restoredState.tracks || tracks).map(t => {
          const fresh = freshById[t.id]
          if (fresh && t.type === 'audio') {
            return { ...t, showTranscript: false, waveform: fresh.waveform, waveformPeaks: fresh.waveformPeaks }
          }
          if (t.type === 'audio') return { ...t, showTranscript: false }
          // Merge filePath from fresh data — older saved states may not have it
          if (fresh && t.type === 'video') {
            return { ...t, filePath: fresh.filePath }
          }
          return t
        })
        return {
          ...state,
          groupId,
          groupDetail,
          tracks: mergedTracks,
          groups: restoredState.groups || groups,
          originalVideoOrder,
          zoom: restoredState.zoom ?? 50,
          audioOnly: restoredState.audioOnly ?? false,
          volume: restoredState.volume ?? 0.7,
          selectedTrackIds: new Set(),
          isDirty: false,
          cuts: restoredState.cuts || [],
          cutExclusions: restoredState.cutExclusions || [],
          aiCutsSelected: restoredState.aiCutsSelected || initialState.aiCutsSelected,
          aiIdentifySelected: restoredState.aiIdentifySelected || initialState.aiIdentifySelected,
          activeTab: restoredState.activeTab || 'sync',
          roughCutTrackMode: restoredState.roughCutTrackMode || 'main',
          compositeShowTranscript: restoredState.compositeShowTranscript ?? false,
          syncTranscriptState: restoredState.syncTranscriptState || null,
          roughcutTranscriptState: restoredState.roughcutTranscriptState ?? null,
          transcriptSelection: null,
          segmentVideoOverrides: restoredState.segmentVideoOverrides || {},
          segmentAudioOverrides: restoredState.segmentAudioOverrides || {},
        }
      }
      return { ...state, groupId, groupDetail, tracks, groups, originalVideoOrder, selectedTrackIds: new Set(), isDirty: false }
    }
    case 'SET_WORD_TIMESTAMPS': {
      const { wordTimestamps } = action.payload
      const tracks = state.tracks.map(t => {
        if (t.type !== 'audio') return t
        const words = wordTimestamps[t.videoId]
        if (!words) return t
        return { ...t, transcriptWords: words, transcriptSentences: buildSentences(words) }
      })
      return { ...state, tracks }
    }
    case 'PLAY':
      return { ...state, isPlaying: true }
    case 'PAUSE':
      return { ...state, isPlaying: false }
    case 'SET_CURRENT_TIME':
      return { ...state, currentTime: action.payload }
    case 'SET_PLAYBACK_RATE':
      return { ...state, playbackRate: action.payload }
    case 'SET_ZOOM':
      return { ...state, zoom: Math.max(5, Math.min(1000, action.payload)), isDirty: true }
    case 'SELECT_TRACK': {
      const { trackId, shift, meta } = action.payload
      const next = new Set(state.selectedTrackIds)
      if (meta) {
        if (next.has(trackId)) next.delete(trackId); else next.add(trackId)
      } else if (shift && next.size > 0) {
        const ids = state.tracks.map(t => t.id)
        const last = [...next].pop()
        const a = ids.indexOf(last), b = ids.indexOf(trackId)
        const [lo, hi] = a < b ? [a, b] : [b, a]
        for (let i = lo; i <= hi; i++) next.add(ids[i])
      } else {
        next.clear()
        next.add(trackId)
      }
      return { ...state, selectedTrackIds: next }
    }
    case 'MOVE_TRACK': {
      const { trackId, newOffset } = action.payload
      const track = state.tracks.find(t => t.id === trackId)
      if (!track) return state
      const clampedOffset = Math.max(0, newOffset)
      let movedTracks
      // If grouped, move all tracks in the group
      if (track.groupId) {
        const group = state.groups[track.groupId]
        if (group) {
          const delta = clampedOffset - track.offset
          movedTracks = state.tracks.map(t =>
            group.trackIds.includes(t.id) ? { ...t, offset: Math.max(0, t.offset + delta) } : t
          )
        }
      }
      if (!movedTracks) {
        movedTracks = state.tracks.map(t => t.id === trackId ? { ...t, offset: clampedOffset } : t)
      }
      return { ...state, tracks: cascadeOverlaps(movedTracks), isDirty: true }
    }
    case 'MOVE_GROUP': {
      const { groupId, delta } = action.payload
      const group = state.groups[groupId]
      if (!group) return state
      const movedTracks = state.tracks.map(t =>
        group.trackIds.includes(t.id) ? { ...t, offset: Math.max(0, t.offset + delta) } : t
      )
      return { ...state, tracks: cascadeOverlaps(movedTracks), isDirty: true }
    }
    case 'TOGGLE_VISIBILITY': {
      const tracks = state.tracks.map(t =>
        t.id === action.payload ? { ...t, visible: !t.visible } : t
      )
      return { ...state, tracks, isDirty: true }
    }
    case 'TOGGLE_MUTE': {
      const tracks = state.tracks.map(t =>
        t.id === action.payload ? { ...t, muted: !t.muted } : t
      )
      return { ...state, tracks, isDirty: true }
    }
    case 'TOGGLE_TRANSCRIPT': {
      const tracks = state.tracks.map(t =>
        t.id === action.payload ? { ...t, showTranscript: !t.showTranscript } : t
      )
      return { ...state, tracks }
    }
    case 'TOGGLE_COMPOSITE_TRANSCRIPT':
      return { ...state, compositeShowTranscript: !state.compositeShowTranscript }
    case 'TOGGLE_AUDIO_ONLY':
      return { ...state, audioOnly: !state.audioOnly, isDirty: true }
    case 'SET_VOLUME':
      return { ...state, volume: action.payload, isDirty: true }
    case 'UNGROUP_TRACK': {
      const { trackId } = action.payload
      const track = state.tracks.find(t => t.id === trackId)
      if (!track?.groupId) return state
      const group = state.groups[track.groupId]
      if (!group) return state
      const newTrackIds = group.trackIds.filter(id => id !== trackId)
      const newGroups = { ...state.groups }
      if (newTrackIds.length <= 1) {
        // Also ungroup the remaining track
        const remaining = state.tracks.find(t => t.id === newTrackIds[0])
        delete newGroups[track.groupId]
        const tracks = state.tracks.map(t =>
          t.id === trackId || t.id === remaining?.id ? { ...t, groupId: null } : t
        )
        return { ...state, tracks, groups: newGroups, isDirty: true }
      }
      newGroups[track.groupId] = { ...group, trackIds: newTrackIds }
      const tracks = state.tracks.map(t => t.id === trackId ? { ...t, groupId: null } : t)
      return { ...state, tracks, groups: newGroups, isDirty: true }
    }
    case 'GROUP_TRACKS': {
      const { trackIds } = action.payload
      if (trackIds.length < 2) return state
      const newGroupId = `g-custom-${Date.now()}`
      const color = GROUP_COLORS[Object.keys(state.groups).length % GROUP_COLORS.length]
      // Remove selected tracks from existing groups
      const newGroups = { ...state.groups }
      for (const gid of Object.keys(newGroups)) {
        newGroups[gid] = {
          ...newGroups[gid],
          trackIds: newGroups[gid].trackIds.filter(id => !trackIds.includes(id))
        }
        if (newGroups[gid].trackIds.length === 0) delete newGroups[gid]
      }
      newGroups[newGroupId] = { color, trackIds }
      const tracks = state.tracks.map(t =>
        trackIds.includes(t.id) ? { ...t, groupId: newGroupId } : t
      )
      return { ...state, tracks, groups: newGroups, isDirty: true }
    }
    case 'SPLIT_TRACK': {
      const { trackId, time } = action.payload
      const idx = state.tracks.findIndex(t => t.id === trackId)
      const track = state.tracks[idx]
      if (!track) return state
      const localTime = time - track.offset
      if (localTime <= 0 || localTime >= track.duration) return state
      const left = { ...track, duration: localTime, id: track.id + '-l' }
      const right = {
        ...track, id: track.id + '-r',
        offset: track.offset + localTime,
        duration: track.duration - localTime,
        originalOffset: track.offset + localTime,
      }
      const tracks = [...state.tracks]
      tracks.splice(idx, 1, left, right)
      // Update group
      const newGroups = { ...state.groups }
      if (track.groupId && newGroups[track.groupId]) {
        const g = newGroups[track.groupId]
        newGroups[track.groupId] = {
          ...g,
          trackIds: g.trackIds.map(id => id === trackId ? left.id : id).concat(right.id)
        }
      }
      return { ...state, tracks, groups: newGroups, isDirty: true }
    }
    case 'REORDER_AUDIO_TRACKS': {
      const { fromIndex, toIndex } = action.payload
      if (fromIndex === toIndex) return state
      const audioTracks = state.tracks.filter(t => t.type === 'audio')
      const nonAudioTracks = state.tracks.filter(t => t.type !== 'audio')
      const reordered = [...audioTracks]
      const [moved] = reordered.splice(fromIndex, 1)
      reordered.splice(toIndex, 0, moved)
      return { ...state, tracks: [...nonAudioTracks, ...reordered], isDirty: true }
    }
    case 'REORDER_VIDEO_TRACKS': {
      const { fromIndex, toIndex } = action.payload
      if (fromIndex === toIndex) return state
      const vidTracks = state.tracks.filter(t => t.type === 'video')
      const nonVidTracks = state.tracks.filter(t => t.type !== 'video')
      const reordered = [...vidTracks]
      const [moved] = reordered.splice(fromIndex, 1)
      reordered.splice(toIndex, 0, moved)
      return { ...state, tracks: [...reordered, ...nonVidTracks], isDirty: true }
    }
    case 'REORDER_TRACK': {
      const { fromIndex, toIndex } = action.payload
      if (fromIndex === toIndex) return state
      const tracks = [...state.tracks]
      const [moved] = tracks.splice(fromIndex, 1)
      tracks.splice(toIndex, 0, moved)
      return { ...state, tracks, isDirty: true }
    }
    case 'RESYNC_TRACK': {
      const tracks = state.tracks.map(t =>
        t.id === action.payload ? { ...t, offset: t.originalOffset } : t
      )
      return { ...state, tracks, isDirty: true }
    }
    case 'OPEN_CONTEXT_MENU':
      return { ...state, contextMenu: action.payload }
    case 'CLOSE_CONTEXT_MENU':
      return { ...state, contextMenu: null }
    case 'MARK_CLEAN':
      return { ...state, isDirty: false }
    case 'SET_ACTIVE_TAB': {
      const from = state.activeTab
      const to = action.payload
      if (from === to) return state
      // Stash current mode's transcript state, restore target mode's
      const stash = {}
      if (from === 'sync') {
        // Save per-track showTranscript map
        const trackTranscripts = {}
        for (const t of state.tracks) {
          if (t.type === 'audio') trackTranscripts[t.id] = t.showTranscript
        }
        stash.syncTranscriptState = trackTranscripts
      } else if (from === 'roughcut') {
        stash.roughcutTranscriptState = state.compositeShowTranscript
      }
      let tracks = state.tracks
      let compositeShowTranscript = state.compositeShowTranscript
      if (to === 'sync' && state.syncTranscriptState) {
        tracks = state.tracks.map(t =>
          t.type === 'audio' && state.syncTranscriptState[t.id] !== undefined
            ? { ...t, showTranscript: state.syncTranscriptState[t.id] }
            : t
        )
      } else if (to === 'roughcut') {
        compositeShowTranscript = state.roughcutTranscriptState ?? true
      }
      return { ...state, ...stash, activeTab: to, tracks, compositeShowTranscript, isDirty: true }
    }
    case 'CLEAR_ROUGH_CUT':
      return { ...state, cuts: [], segmentVideoOverrides: {}, segmentAudioOverrides: {}, roughcutTranscriptState: null, isDirty: true }
    case 'ADD_CUT':
      return { ...state, cuts: [...state.cuts, action.payload], isDirty: true }
    case 'REMOVE_CUT':
      return { ...state, cuts: state.cuts.filter(c => c.id !== action.payload), isDirty: true }
    case 'EXCLUDE_FROM_CUT': {
      const { wordStart, wordEnd } = action.payload
      // Toggle: if already excluded, re-include
      const existing = state.cutExclusions.findIndex(e => Math.abs(e.start - wordStart) < 0.01)
      if (existing >= 0) {
        return { ...state, cutExclusions: state.cutExclusions.filter((_, i) => i !== existing), isDirty: true }
      }
      return { ...state, cutExclusions: [...state.cutExclusions, { start: wordStart, end: wordEnd }], isDirty: true }
    }
    case 'UPDATE_CUT':
      return { ...state, cuts: state.cuts.map(c => c.id === action.payload.id ? { ...c, ...action.payload.updates } : c), isDirty: true }
    case 'SET_AI_CUTS': {
      const { prefix, cuts } = action.payload
      return { ...state, cuts: [...state.cuts.filter(c => !c.id.startsWith(prefix)), ...cuts], isDirty: true }
    }
    case 'SET_AI_CUTS_SELECTED':
      return { ...state, aiCutsSelected: { ...state.aiCutsSelected, ...action.payload }, isDirty: true }
    case 'SET_AI_IDENTIFY_SELECTED':
      return { ...state, aiIdentifySelected: { ...state.aiIdentifySelected, ...action.payload }, isDirty: true }
    case 'SET_ROUGH_CUT_TRACK_MODE':
      return { ...state, roughCutTrackMode: action.payload }
    case 'SET_TRANSCRIPT_SELECTION':
      return { ...state, transcriptSelection: action.payload }
    case 'SET_SEGMENT_VIDEO_OVERRIDE': {
      const { segIndex, videoId } = action.payload
      return { ...state, segmentVideoOverrides: { ...state.segmentVideoOverrides, [segIndex]: videoId }, isDirty: true }
    }
    case 'SET_SEGMENT_AUDIO_OVERRIDE': {
      const { segIndex, videoId } = action.payload
      return { ...state, segmentAudioOverrides: { ...state.segmentAudioOverrides, [segIndex]: videoId }, isDirty: true }
    }
    case 'SET_ANNOTATIONS':
      return { ...state, annotations: action.payload }
    case 'DISMISS_ANNOTATION': {
      if (!state.annotations) return state
      return {
        ...state,
        annotations: {
          ...state.annotations,
          items: state.annotations.items.filter(a => a.id !== action.payload),
        },
      }
    }
    default:
      return state
  }
}

// Actions that create undo history entries
const TRACKED_ACTIONS = new Set([
  'MOVE_TRACK', 'MOVE_GROUP', 'REORDER_TRACK',
  'REORDER_AUDIO_TRACKS', 'REORDER_VIDEO_TRACKS',
  'TOGGLE_VISIBILITY', 'TOGGLE_MUTE', 'TOGGLE_TRANSCRIPT', 'TOGGLE_COMPOSITE_TRANSCRIPT', 'TOGGLE_AUDIO_ONLY',
  'SPLIT_TRACK', 'UNGROUP_TRACK', 'GROUP_TRACKS', 'RESYNC_TRACK',
  'SET_ZOOM', 'SET_VOLUME',
  'ADD_CUT', 'REMOVE_CUT', 'EXCLUDE_FROM_CUT', 'UPDATE_CUT', 'SET_AI_CUTS', 'SET_AI_IDENTIFY_SELECTED',
  'SET_SEGMENT_VIDEO_OVERRIDE', 'SET_SEGMENT_AUDIO_OVERRIDE',
])

// Actions that coalesce (rapid-fire same type = one undo step, e.g. dragging)
const COALESCE_ACTIONS = new Set([
  'MOVE_TRACK', 'MOVE_GROUP', 'SET_ZOOM', 'SET_VOLUME',
])

const HISTORY_LIMIT = 100

function undoableReducer(historyState, action) {
  switch (action.type) {
    case 'UNDO': {
      if (historyState.past.length === 0) return historyState
      const prev = historyState.past[historyState.past.length - 1]
      return {
        past: historyState.past.slice(0, -1),
        present: prev,
        future: [historyState.present, ...historyState.future.slice(0, HISTORY_LIMIT - 1)],
        lastActionType: null,
      }
    }
    case 'REDO': {
      if (historyState.future.length === 0) return historyState
      const next = historyState.future[0]
      return {
        past: [...historyState.past, historyState.present],
        present: next,
        future: historyState.future.slice(1),
        lastActionType: null,
      }
    }
    default: {
      const newPresent = reducer(historyState.present, action)
      if (newPresent === historyState.present) return historyState

      if (!TRACKED_ACTIONS.has(action.type)) {
        return { ...historyState, present: newPresent }
      }

      // Coalesce consecutive same-type actions (drag = one undo step)
      if (COALESCE_ACTIONS.has(action.type) && historyState.lastActionType === action.type) {
        return { ...historyState, present: newPresent }
      }

      return {
        past: [...historyState.past.slice(-(HISTORY_LIMIT - 1)), historyState.present],
        present: newPresent,
        future: [],
        lastActionType: action.type,
      }
    }
  }
}

function serializeState(state) {
  const { tracks, groups, zoom, audioOnly, volume, cuts, cutExclusions, aiCutsSelected, aiIdentifySelected, activeTab, roughCutTrackMode, compositeShowTranscript, syncTranscriptState, roughcutTranscriptState, segmentVideoOverrides, segmentAudioOverrides } = state
  const serializableTracks = tracks.map(({ transcriptSegments, transcriptWords, transcriptSentences, waveform, waveformPeaks, ...rest }) => rest)
  return { tracks: serializableTracks, groups, zoom, audioOnly, volume, cuts, cutExclusions, aiCutsSelected, aiIdentifySelected, activeTab, roughCutTrackMode, compositeShowTranscript, syncTranscriptState, roughcutTranscriptState, segmentVideoOverrides, segmentAudioOverrides }
}

export default function useEditorState() {
  const [historyState, dispatch] = useReducer(undoableReducer, initialState, (init) => ({
    past: [],
    present: init,
    future: [],
    lastActionType: null,
  }))
  const state = historyState.present
  const canUndo = historyState.past.length > 0
  const canRedo = historyState.future.length > 0
  const saveTimer = useRef(null)
  const latestState = useRef(state)
  latestState.current = state

  // Auto-save when dirty (debounced 1500ms)
  useEffect(() => {
    if (!state.isDirty || !state.groupId) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        await apiPut(`/videos/groups/${state.groupId}/editor-state`, {
          editor_state: serializeState(state)
        })
        dispatch({ type: 'MARK_CLEAN' })
      } catch (e) {
        console.error('[editor] Auto-save failed:', e)
      }
    }, 1500)
    return () => clearTimeout(saveTimer.current)
  }, [state.isDirty, state.tracks, state.groups, state.zoom, state.audioOnly, state.volume, state.groupId, state.cuts, state.activeTab])

  // Flush pending save on unmount (navigation away) and tab close
  useEffect(() => {
    const flushSave = () => {
      const s = latestState.current
      if (!s.isDirty || !s.groupId) return
      const body = JSON.stringify({ editor_state: serializeState(s) })
      navigator.sendBeacon(`/api/videos/groups/${s.groupId}/editor-state-beacon`, body)
    }
    const onBeforeUnload = () => flushSave()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      // Component unmounting (navigation) — flush synchronously
      flushSave()
    }
  }, [])

  const totalDuration = state.tracks.reduce((max, t) => Math.max(max, t.offset + t.duration), 0)

  return { state, dispatch, totalDuration, formatTime, canUndo, canRedo }
}

export { formatTime, formatTimeRuler, GROUP_COLORS, buildSentences }
