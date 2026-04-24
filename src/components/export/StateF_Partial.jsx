// Task 2 fills this in — real State F UI. Replaces StateF_Partial_Placeholder.
// Renders per-failure diagnostics + retry + generate-anyway + report-issue stub.
//
// Props:
//   complete        — extension's {type:"complete"} payload (ok_count, fail_count, folder_path)
//   snapshot        — useExportPort snapshot with items[]; failed items have phase='failed' + error_code
//   exportId        — the completed run's export_id (for "Generate XML anyway")
//   variantLabels   — e.g. ['A', 'C']
//   unifiedManifest — the manifest built at State C (threaded through ExportPage state)
//   onRetryFailed   — callback to kick a fresh export with only the failed subset
//
// See docs/superpowers/plans/2026-04-24-webapp-state-f-partial-ui.md
// for the full "Why read this before touching code" invariants.

export default function StateF_Partial(_props) {
  return null
}
