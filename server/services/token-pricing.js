// Shared pricing helpers for AI Rough Cut.
//
// Used by:
//   - server/routes/videos.js (/estimate-ai-roughcut — user-facing preview)
//   - server/services/rough-cut-runner.js (actual transactional deduction)
//   - server/services/auto-orchestrator.js (slice 2's heuristic combined estimate)
//
// Single source of truth so the preview and the deduction can never drift.
//
// Returns 0 when duration is unknown/zero — the frontend (StepRoughCut.jsx)
// polls while tokenCost === 0 and stops when it becomes positive, so 0 is
// the correct signal for "no videos uploaded yet, keep polling". The
// minimum-1 floor that prevents zero-cost charges lives in the deduction
// path (rough-cut-runner.js), not the estimator.

export function estimateTokenCost(durationSeconds) {
  const minutes = (durationSeconds || 0) / 60
  return Math.ceil(minutes * 30) // 30 tokens per minute, 0 when no duration
}

export function estimateProcessingTime(durationSeconds) {
  const minutes = (durationSeconds || 0) / 60
  return Math.round(minutes * 0.375 * 60) // 0.375 min processing per min of video → seconds
}
