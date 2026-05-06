import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useApi, apiDelete } from '../../hooks/useApi.js'
import { resolveProjectRoute } from '../../lib/projectRoute.js'
import { Home, LayoutGrid, List, Film, Loader2, CheckCircle2, AlertCircle, Trash2 } from 'lucide-react'
import UploadModal from './UploadModal.jsx'
import UploadConfigFlow from '../upload-config/UploadConfigFlow.jsx'
import ProcessingModal from './ProcessingModal.jsx'

const tabs = ['Recent', 'Owned by me', 'Shared with me']
const CONFIG_STEPS = new Set(['libraries', 'audience', 'references', 'roughcut', 'path'])

// Compute the effective broll_chain_status / substage for a project row
// by aggregating its sub-groups. The chain runs on sub-groups (created by
// multicam classification) — the parent project row never holds it
// directly. Used to feed resolveProjectRoute correctly when the user
// clicks a parent row.
//
// Aggregation rule (priority — first match wins):
//   1. any sub-group running/pending → 'running'
//   2. any sub-group failed          → 'failed' (substage from that sub-group)
//   3. any sub-group paused_at_*     → that paused state
//   4. all sub-groups done           → 'done'
//   5. otherwise                     → null
//
// Exported for unit tests in __tests__/ProjectsView-aggregate.test.js.
export function aggregateChainStatus(subGroups = []) {
  if (!subGroups.length) return { status: null, substage: null }

  const running = subGroups.find(sg =>
    sg.broll_chain_status === 'running' || sg.broll_chain_status === 'pending',
  )
  if (running) return { status: 'running', substage: running.broll_chain_substage || null }

  const failed = subGroups.find(sg => sg.broll_chain_status === 'failed')
  if (failed) return { status: 'failed', substage: failed.broll_chain_substage || null }

  const pausedRoughCut = subGroups.find(sg => sg.broll_chain_status === 'paused_at_rough_cut')
  if (pausedRoughCut) return { status: 'paused_at_rough_cut', substage: 'rough_cut' }

  const pausedStrategy = subGroups.find(sg => sg.broll_chain_status === 'paused_at_strategy')
  if (pausedStrategy) return { status: 'paused_at_strategy', substage: 'strategy' }

  const pausedPlan = subGroups.find(sg => sg.broll_chain_status === 'paused_at_plan')
  if (pausedPlan) return { status: 'paused_at_plan', substage: 'plan' }

  if (subGroups.every(sg => sg.broll_chain_status === 'done')) {
    return { status: 'done', substage: null }
  }

  return { status: null, substage: null }
}

// Compute how far through the slice-2 chain a project is. Stages mirror
// the orchestrator's pipeline: upload → transcribe → classify → sync →
// rough_cut → broll. We treat a project as terminal (full bar, no
// "Processing" badge) when it's hit final assembly + (broll done OR no
// auto-broll path). `total` is fixed at 6 so the badge reads stably.
//
// Sync semantics: for any classification-split project (i.e. every
// full-auto run), sync runs on sub-groups; the parent's assembly_status
// sticks at 'confirmed' permanently. The /videos query exposes the
// sub-group's rough_cut_status / broll_chain_status via COALESCE, but
// COALESCE on assembly_status returns parent's 'confirmed' (non-null)
// instead of sub's 'done'. We detect sync-done via causal dependency:
// rough_cut and broll_chain only fire after sync, so any non-null status
// from those implies sync has completed. `assembly_status === 'done'`
// still covers the legacy single-group case where parent IS the synced group.
export function aggregateProgress(p) {
  const stages = ['upload', 'transcribe', 'classify', 'sync', 'rough_cut', 'broll']
  const done = []
  if (p.transcriptionStatus === 'done') { done.push('upload', 'transcribe') }
  if (p.assembly_status === 'confirmed' || p.assembly_status === 'done') done.push('classify')
  const syncDone = p.assembly_status === 'done'
    || p.rough_cut_status != null
    || p.broll_chain_status != null
  if (syncDone) done.push('sync')
  if (p.rough_cut_status === 'done' || !p.auto_rough_cut) done.push('rough_cut')
  if (p.broll_chain_status === 'done') done.push('broll')
  const isTerminal = syncDone && (p.broll_chain_status === 'done' || !p.path_id || p.path_id === 'guided')
  return { done: done.length, total: stages.length, terminal: isTerminal }
}

export default function ProjectsView() {
  const { data: videos, loading, refetch } = useApi('/videos')
  const [activeTab, setActiveTab] = useState('Recent')
  const [viewMode, setViewMode] = useState('list')
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  // Flow state from URL — files kept in ref (can't serialize XHR to URL)
  const filesRef = useRef(null)
  const [liveFiles, setLiveFiles] = useState(null) // real-time file updates from UploadModal
  const step = searchParams.get('step')
  const groupId = searchParams.get('group') ? parseInt(searchParams.get('group')) : null

  // Legacy URL redirects — old flow used ?step=config and ?step=broll-examples
  useEffect(() => {
    if (step === 'config') {
      setSearchParams(
        groupId ? { step: 'libraries', group: String(groupId) } : {},
        { replace: true }
      )
    }
    if (step === 'broll-examples') {
      setSearchParams(
        { step: 'references', ...(groupId ? { group: String(groupId) } : {}) },
        { replace: true }
      )
    }
  }, [step, groupId, setSearchParams])

  // Guard against malformed URLs: config/processing steps require a valid
  // numeric group id. Without one, polling/persistence hits /groups/NaN
  // (or /groups/null) and silently fails — strand the user on a dead page.
  useEffect(() => {
    const needsGroup = CONFIG_STEPS.has(step) || step === 'processing'
    if (needsGroup && !Number.isFinite(groupId)) {
      setSearchParams({}, { replace: true })
    }
  }, [step, groupId, setSearchParams])

  const setStep = useCallback((newStep, newGroupId, files) => {
    if (files !== undefined) filesRef.current = files
    if (!newStep) {
      setSearchParams({}, { replace: true })
    } else if (newGroupId) {
      setSearchParams({ step: newStep, group: String(newGroupId) }, { replace: true })
    } else {
      setSearchParams({ step: newStep }, { replace: true })
    }
  }, [setSearchParams])

  // Group videos by group_id to build projects list
  const projects = (() => {
    if (!videos) return []
    const groupMap = {}
    for (const v of videos) {
      if (v.group_id == null) continue
      const gid = v.group_id
      if (!groupMap[gid]) {
        groupMap[gid] = {
          id: v.group_id,
          name: v.group_name || v.title,
          videos: [],
          created_at: v.created_at,
          assembly_status: v.group_assembly_status,
          isGroup: !!v.group_id,
          // Group-level config fields (included by GET /videos when joined from video_groups).
          libraries: v.libraries || [],
          freepik_opt_in: v.freepik_opt_in === undefined ? true : v.freepik_opt_in,
          audience: v.audience || null,
          path_id: v.path_id || null,
          auto_rough_cut: !!v.auto_rough_cut,
          // Pipeline status fields used by aggregateProgress for the
          // Full Auto / Strategy / Guided badge on the list row.
          rough_cut_status: v.rough_cut_status || null,
          broll_chain_status: v.broll_chain_status || null,
        }
      }
      groupMap[gid].videos.push(v)
      // Use earliest created_at
      if (v.created_at < groupMap[gid].created_at) {
        groupMap[gid].created_at = v.created_at
      }
    }
    // Compute transcription summary per project
    for (const p of Object.values(groupMap)) {
      const total = p.videos.length
      const done = p.videos.filter(v => v.transcription_status === 'done').length
      const failed = p.videos.filter(v => v.transcription_status === 'failed').length
      const active = p.videos.filter(v =>
        v.transcription_status && !['done', 'failed'].includes(v.transcription_status)
      ).length
      if (done === total) p.transcriptionStatus = 'done'
      else if (failed > 0 && active === 0 && done + failed === total) p.transcriptionStatus = 'failed'
      else if (active > 0) p.transcriptionStatus = 'transcribing'
      else if (done > 0) p.transcriptionStatus = 'partial'
      else p.transcriptionStatus = null
      p.transcriptionDone = done
      p.transcriptionTotal = total
    }
    return Object.values(groupMap).sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at)
    )
  })()

  // Seed config flow with any existing saved config for the active group.
  // Requires GET /videos to include libraries_json / audience_json / freepik_opt_in / path_id — see server/routes/videos.js list handler.
  const currentGroup = projects.find(p => p.id === groupId) || null
  const initialConfig = currentGroup ? {
    libraries: currentGroup.libraries || [],
    freepikOptIn: currentGroup.freepik_opt_in !== false,
    audience: currentGroup.audience || undefined,
    pathId: currentGroup.path_id || undefined,
    autoRoughCut: !!currentGroup.auto_rough_cut,
  } : null

  const handleProjectClick = (project) => {
    // Parent project rows never carry broll_chain_status directly — the
    // chain runs on their sub-groups. Aggregate before routing so a
    // failed-pre-pause sub-group correctly sends the user to <FailedView>
    // and a done sub-group lets them into the editor.
    //
    // We use sub_group_id + sub_group_broll_chain_{status,substage} (raw,
    // pre-COALESCE values from the videos endpoint) so multiple sub-groups
    // under the same parent get one entry each in the aggregation set.
    // If parent_group_id isn't exposed (legacy single-group projects), the
    // filter is empty and we fall back to the project's own chain status.
    const subGroups = (videos || [])
      .filter(v => v.parent_group_id === project.id && v.sub_group_id != null)
      .reduce((acc, v) => {
        if (!acc.find(sg => sg.id === v.sub_group_id)) {
          acc.push({
            id: v.sub_group_id,
            broll_chain_status: v.sub_group_broll_chain_status || null,
            broll_chain_substage: v.sub_group_broll_chain_substage || null,
          })
        }
        return acc
      }, [])
    const aggregated = subGroups.length
      ? aggregateChainStatus(subGroups)
      : { status: project.broll_chain_status, substage: project.broll_chain_substage }
    navigate(resolveProjectRoute({
      ...project,
      broll_chain_status: aggregated.status,
      broll_chain_substage: aggregated.substage,
    }))
  }

  const handleDelete = async (e, project) => {
    e.stopPropagation()
    if (!confirm(`Delete "${project.name}"? This will remove all videos and transcripts permanently.`)) return
    // Remove from UI immediately
    refetch(true) // silent refetch to update without loading state
    apiDelete(`/videos/groups/${project.id}`).then(() => refetch(true)).catch(() => refetch())
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-muted" size={24} />
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-semibold text-white">Projects</h1>
        <button
          onClick={() => setStep('upload')}
          className="bg-lime text-black px-4 py-2 rounded-md font-medium text-sm hover:opacity-90 transition-opacity flex items-center space-x-1"
        >
          <span>New project</span>
        </button>
      </div>

      {/* Tabs + View toggle */}
      <div className="flex items-center justify-between mb-16 border-b border-border-subtle pb-2">
        <div className="flex space-x-1 bg-surface p-1 rounded-lg">
          {tabs.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'bg-surface-dark text-white shadow-sm'
                  : 'text-muted hover:text-gray-300'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        <div className="flex bg-surface p-1 rounded-lg">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-1.5 rounded transition-colors ${
              viewMode === 'grid'
                ? 'bg-surface-dark text-white shadow-sm'
                : 'text-muted hover:text-gray-300'
            }`}
          >
            <LayoutGrid size={14} />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-1.5 rounded transition-colors ${
              viewMode === 'list'
                ? 'bg-surface-dark text-white shadow-sm'
                : 'text-muted hover:text-gray-300'
            }`}
          >
            <List size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      {projects.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center justify-center text-center mt-32 max-w-lg mx-auto">
          <div className="w-16 h-16 bg-surface rounded-full flex items-center justify-center mb-6 border border-border-subtle">
            <Home size={28} className="text-muted" />
          </div>
          <h2 className="text-gray-200 text-lg mb-2">
            All projects you have access to in this drive will show up here.
          </h2>
          <p className="text-muted text-sm mb-8">
            Here you can manage visibility and share projects with collaborators.
          </p>
          <button
            onClick={() => setStep('upload')}
            className="bg-transparent border border-border-subtle text-gray-200 px-6 py-2 rounded-md font-medium text-sm hover:bg-surface transition-colors"
          >
            New project
          </button>
        </div>
      ) : viewMode === 'list' ? (
        /* List view */
        <div className="space-y-1">
          {projects.map(project => (
            <button
              key={project.id}
              onClick={() => handleProjectClick(project)}
              className="w-full flex items-center gap-4 px-4 py-3 rounded-md hover:bg-surface transition-colors text-left group"
            >
              <div className="w-10 h-10 bg-surface rounded-md flex items-center justify-center border border-border-subtle group-hover:border-lime/30 transition-colors">
                <Film size={18} className="text-muted" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-100 truncate">
                  {project.name}
                </div>
                <div className="text-xs text-muted mt-0.5 flex items-center gap-2">
                  <span>{project.videos.length} video{project.videos.length !== 1 ? 's' : ''}</span>
                  <span>· #{project.id}</span>
                  {(() => {
                    // Highest priority: chain paused for human review. The
                    // "Processing N/6" + legacy badges are both wrong here —
                    // the project isn't processing and isn't done; it's
                    // waiting on the user. resolveProjectRoute now sends the
                    // click to the processing modal, where StageTimeline
                    // surfaces the actual review CTA.
                    const PAUSED_LABELS = {
                      paused_at_rough_cut: 'Awaiting rough cut review',
                      paused_at_strategy: 'Awaiting strategy review',
                      paused_at_plan: 'Awaiting plan review',
                    }
                    const pausedLabel = PAUSED_LABELS[project.broll_chain_status]
                    if (pausedLabel) {
                      return (
                        <span className="text-amber-400 flex items-center gap-1">
                          <AlertCircle size={11} />
                          {pausedLabel}
                        </span>
                      )
                    }
                    // Auto-path projects show a single aggregate badge that
                    // takes precedence over the per-stage transcription /
                    // assembly statuses below — once the chain is mid-flight,
                    // the user mostly cares about overall progress, not
                    // which intermediate stage is currently running.
                    const ap = aggregateProgress(project)
                    if (project.path_id && ['hands-off', 'strategy-only', 'guided'].includes(project.path_id) && !ap.terminal) {
                      return (
                        <span className="text-amber-400 flex items-center gap-1">
                          <Loader2 size={11} className="animate-spin" />
                          Processing · {ap.done}/{ap.total}
                        </span>
                      )
                    }
                    return null
                  })()}
                  {(() => {
                    // Fall through to the legacy per-stage badges only when
                    // neither the paused-for-review nor the aggregate badge
                    // is displayed. Avoids two badges fighting for space.
                    const PAUSED_STATUSES = ['paused_at_rough_cut', 'paused_at_strategy', 'paused_at_plan']
                    if (PAUSED_STATUSES.includes(project.broll_chain_status)) return null
                    const ap = aggregateProgress(project)
                    const aggregateActive = project.path_id && ['hands-off', 'strategy-only', 'guided'].includes(project.path_id) && !ap.terminal
                    if (aggregateActive) return null
                    return (
                      <>
                        {project.transcriptionStatus === 'done' ? (
                          <span className="text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 size={11} /> Transcribed
                          </span>
                        ) : project.transcriptionStatus === 'transcribing' ? (
                          <span className="text-amber-400 flex items-center gap-1">
                            <Loader2 size={11} className="animate-spin" /> {project.transcriptionDone}/{project.transcriptionTotal} transcribed
                          </span>
                        ) : project.transcriptionStatus === 'partial' ? (
                          <span className="text-amber-400">{project.transcriptionDone}/{project.transcriptionTotal} transcribed</span>
                        ) : project.transcriptionStatus === 'failed' ? (
                          <span className="text-red-400 flex items-center gap-1">
                            <AlertCircle size={11} /> Transcription failed
                          </span>
                        ) : null}
                        {project.assembly_status && (
                          <span className={
                            project.assembly_status === 'done' ? 'text-emerald-400' :
                            project.assembly_status === 'failed' ? 'text-red-400' :
                            'text-amber-400'
                          }>
                            · {project.assembly_status}
                          </span>
                        )}
                      </>
                    )
                  })()}
                </div>
              </div>
              <div className="text-xs text-muted">
                {new Date(project.created_at).toLocaleDateString()}
              </div>
              <div
                onClick={(e) => handleDelete(e, project)}
                className="opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-red-500/20 text-muted hover:text-red-400 transition-all cursor-pointer"
              >
                <Trash2 size={14} />
              </div>
            </button>
          ))}
        </div>
      ) : (
        /* Grid view */
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {projects.map(project => (
            <button
              key={project.id}
              onClick={() => handleProjectClick(project)}
              className="bg-surface rounded-lg p-4 hover:bg-surface/80 transition-colors text-left border border-transparent hover:border-lime/20 group"
            >
              <div className="w-full aspect-video bg-obsidian rounded-md flex items-center justify-center mb-3 border border-border-subtle relative">
                <Film size={24} className="text-muted" />
                <div
                  onClick={(e) => handleDelete(e, project)}
                  className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 p-1.5 rounded bg-black/60 hover:bg-red-500/30 text-muted hover:text-red-400 transition-all cursor-pointer"
                >
                  <Trash2 size={14} />
                </div>
              </div>
              <div className="text-sm font-medium text-gray-100 truncate">
                {project.name}
              </div>
              <div className="text-xs text-muted mt-1">
                {project.videos.length} video{project.videos.length !== 1 ? 's' : ''} · #{project.id} · {new Date(project.created_at).toLocaleDateString()}
              </div>
              {project.transcriptionStatus === 'done' ? (
                <div className="text-[10px] text-emerald-400 mt-1 flex items-center gap-1">
                  <CheckCircle2 size={10} /> Transcribed
                </div>
              ) : project.transcriptionStatus === 'transcribing' ? (
                <div className="text-[10px] text-amber-400 mt-1 flex items-center gap-1">
                  <Loader2 size={10} className="animate-spin" /> {project.transcriptionDone}/{project.transcriptionTotal}
                </div>
              ) : project.transcriptionStatus === 'failed' ? (
                <div className="text-[10px] text-red-400 mt-1 flex items-center gap-1">
                  <AlertCircle size={10} /> Failed
                </div>
              ) : null}
            </button>
          ))}
        </div>
      )}

      {/* UploadModal stays mounted across upload → config → processing so
          in-flight TUS uploads keep streaming progress to filesRef/liveFiles.
          Hidden via display:none on every step except 'upload'. */}
      {(step === 'upload' || CONFIG_STEPS.has(step) || step === 'processing') && (
        <div style={{ display: step === 'upload' ? undefined : 'none' }}>
          <UploadModal
            onClose={() => setStep(null)}
            onComplete={(gid, files) => setStep('libraries', gid, files)}
            initialGroupId={groupId}
            onFilesChange={(f) => { filesRef.current = f; setLiveFiles(f) }}
          />
        </div>
      )}

      {CONFIG_STEPS.has(step) && (
        <UploadConfigFlow
          key={groupId /* key by group so state resets when the project changes */}
          groupId={groupId}
          initialState={initialConfig}
          onBack={() => setStep('upload', groupId)}
          onComplete={(gid) => setStep('processing', gid)}
        />
      )}

      {step === 'processing' && (
        <ProcessingModal
          groupId={groupId}
          initialFiles={filesRef.current}
          liveFiles={liveFiles}
          onBack={() => setStep('path', groupId)}
          onComplete={(gid) => {
            setStep(null); refetch(); navigate(`/editor/${gid}/assets`)
          }}
        />
      )}
    </div>
  )
}
