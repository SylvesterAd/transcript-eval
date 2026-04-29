// Determines where clicking a project on the projects list should
// navigate. Pure function — takes a project object as built by
// ProjectsView.jsx and returns a relative URL. Tested in
// __tests__/projectRoute.test.js.
//
// Priority:
//   1. Config not finished (libraries → audience → refs → rough-cut → path)
//   2. Still processing (assembly / rough-cut / broll chain in flight)
//   3. Ready for editor

// 'done' = single-group flow (no classification split needed).
// 'confirmed' = parent project where the user has confirmed the
// classification and sub-groups now exist; this is the terminal state
// for parent groups. Both should route into the editor — only mid-
// flight states ('classifying', 'classified', 'transcribing') gate.
const ASSEMBLY_DONE_VALUES = new Set(['done', 'confirmed'])
const CHAIN_IN_PROGRESS = new Set(['pending', 'running'])

export function resolveProjectRoute(project) {
  const id = project.id

  if (!project.libraries || project.libraries.length === 0) {
    return `/?step=libraries&group=${id}`
  }
  if (!project.audience) {
    return `/?step=audience&group=${id}`
  }
  if (!project.path_id) {
    return `/?step=path&group=${id}`
  }

  if (!ASSEMBLY_DONE_VALUES.has(project.assembly_status)) {
    return `/?step=processing&group=${id}`
  }
  if (CHAIN_IN_PROGRESS.has(project.rough_cut_status)) {
    return `/?step=processing&group=${id}`
  }
  if (CHAIN_IN_PROGRESS.has(project.broll_chain_status)) {
    return `/?step=processing&group=${id}`
  }

  return `/editor/${id}/assets`
}
