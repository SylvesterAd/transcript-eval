// Determines where clicking a project on the projects list should
// navigate. Pure function — takes a project object as built by
// ProjectsView.jsx and returns a relative URL. Tested in
// __tests__/projectRoute.test.js.
//
// Priority:
//   1. Pre-upload (assembly_status null/pending/deleting): resume the
//      config flow at the first incomplete step.
//   2. Post-upload, still processing: ?step=processing&group=ID.
//   3. Post-upload, ready: editor.
//
// The pre-upload gate exists because audience/path columns were added
// after some projects were created. Those legacy projects have
// audience_json = NULL and path_id = NULL but assembly_status =
// 'confirmed' or 'done' — they've already moved past upload, just
// without the new config columns. We must NOT redirect them back into
// the config flow.

const ASSEMBLY_DONE_VALUES = new Set(['done', 'confirmed'])
const CHAIN_IN_PROGRESS = new Set(['pending', 'running'])

// Auto-orchestration paths and their natural pause-point. The chain
// transitions through substages rough_cut → refs → strategy → plan → search → done.
// A `null` pause means the path has no checkpoint (Full Auto).
const PATH_PAUSE_SUBSTAGE = {
  'hands-off': null,
  'strategy-only': 'strategy',
  'guided': 'rough_cut',
}
const SUBSTAGE_ORDER = ['rough_cut', 'refs', 'strategy', 'plan', 'search']
const AUTO_PATHS = new Set(Object.keys(PATH_PAUSE_SUBSTAGE))

// True when the chain failed BEFORE this path's natural pause-point.
// Routing rule: pre-pause failure → loader (`<FailedView>`), because
// the user has nothing to act on yet. Post-pause failure → editor,
// because the user already engaged and partial outputs exist for them
// to inspect or manually retry.
export function failedPrePause(project) {
  if (project.broll_chain_status !== 'failed') return false
  if (!AUTO_PATHS.has(project.path_id)) return false
  const pause = PATH_PAUSE_SUBSTAGE[project.path_id]
  if (pause === null) return true   // hands-off has no pause → always pre
  const failIdx = SUBSTAGE_ORDER.indexOf(project.broll_chain_substage)
  if (failIdx < 0) return true      // unknown substage → assume pre-pause (safer)
  return failIdx <= SUBSTAGE_ORDER.indexOf(pause)
}

function isPreUpload(assemblyStatus) {
  return assemblyStatus == null
    || assemblyStatus === 'pending'
    || assemblyStatus === 'deleting'
}

export function resolveProjectRoute(project) {
  const id = project.id
  const assembly = project.assembly_status

  if (isPreUpload(assembly)) {
    if (!project.libraries || project.libraries.length === 0) {
      return `/?step=libraries&group=${id}`
    }
    if (!project.audience) {
      return `/?step=audience&group=${id}`
    }
    if (!project.path_id) {
      return `/?step=path&group=${id}`
    }
    return `/?step=processing&group=${id}`
  }

  if (!ASSEMBLY_DONE_VALUES.has(assembly)) {
    return `/?step=processing&group=${id}`
  }
  if (CHAIN_IN_PROGRESS.has(project.rough_cut_status)) {
    return `/?step=processing&group=${id}`
  }
  if (CHAIN_IN_PROGRESS.has(project.broll_chain_status)) {
    return `/?step=processing&group=${id}`
  }
  // All paused_at_* checkpoints route to the processing modal: <StageTimeline>
  // renders the paused stage with a "Open project to pick" CTA pointing at
  // the right sub-group review tab. Routing straight to /editor/PARENT/assets
  // (the older intentional-checkpoint design) drops the user into the parent's
  // asset list with no signal that strategy/plan review is waiting on them.
  if (
    project.broll_chain_status === 'paused_at_rough_cut'
    || project.broll_chain_status === 'paused_at_strategy'
    || project.broll_chain_status === 'paused_at_plan'
  ) {
    return `/?step=processing&group=${id}`
  }
  // Failure routing: hold pre-pause failures on the loader so the user
  // sees <FailedView> with a Contact Support CTA. Post-pause failures
  // and null-path failures fall through to the editor where they get a
  // non-blocking banner (EditorView.jsx).
  if (failedPrePause(project)) {
    return `/?step=processing&group=${id}`
  }
  if (AUTO_PATHS.has(project.path_id) && project.broll_chain_status == null) {
    return `/?step=processing&group=${id}`
  }
  return `/editor/${id}/assets`
}
