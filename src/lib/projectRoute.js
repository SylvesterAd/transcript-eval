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

// 'done' = single-group flow (no classification split needed).
// 'confirmed' = parent project where the user has confirmed the
// classification and sub-groups now exist; this is the terminal state
// for parent groups. Both should route into the editor — only mid-
// flight states ('classifying', 'classified', 'transcribing') gate.
const ASSEMBLY_DONE_VALUES = new Set(['done', 'confirmed'])
const CHAIN_IN_PROGRESS = new Set(['pending', 'running'])
// Auto-orchestration paths. For these projects, the b-roll chain MUST
// progress from null → pending → running → done after assembly. A null
// broll_chain_status post-assembly means the chain trigger never fired or
// stalled before writing 'pending' — the processing page surfaces that
// instead of dropping the user into an empty editor.
const AUTO_PATHS = new Set(['hands-off', 'strategy-only', 'guided'])

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
    // All config done but assembly hasn't kicked off — drop into the
    // processing view; it'll trigger transcription on its own.
    return `/?step=processing&group=${id}`
  }

  // Past upload — don't re-prompt for config even if columns are NULL
  // (legacy projects created before audience/path were required).
  if (!ASSEMBLY_DONE_VALUES.has(assembly)) {
    return `/?step=processing&group=${id}`
  }
  if (CHAIN_IN_PROGRESS.has(project.rough_cut_status)) {
    return `/?step=processing&group=${id}`
  }
  if (CHAIN_IN_PROGRESS.has(project.broll_chain_status)) {
    return `/?step=processing&group=${id}`
  }
  if (AUTO_PATHS.has(project.path_id) && project.broll_chain_status == null) {
    return `/?step=processing&group=${id}`
  }
  return `/editor/${id}/assets`
}
