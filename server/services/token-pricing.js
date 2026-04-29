// Shared pricing helpers for AI Rough Cut.
//
// Used by:
//   - server/routes/videos.js (/estimate-ai-roughcut — user-facing preview)
//   - server/services/rough-cut-runner.js (actual transactional deduction)
//   - server/services/auto-orchestrator.js (slice 2's heuristic combined estimate)
//
// Single source of truth so the preview and the deduction can never drift.

export function estimateTokenCost(durationSeconds) {
  const minutes = (durationSeconds || 0) / 60
  return Math.max(1, Math.ceil(minutes * 30)) // 30 tokens per minute, minimum 1
}

export function estimateProcessingTime(durationSeconds) {
  const minutes = (durationSeconds || 0) / 60
  return Math.round(minutes * 0.375 * 60) // 0.375 min processing per min of video → seconds
}
