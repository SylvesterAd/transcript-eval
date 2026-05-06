// Frontend mirror of server/services/token-pricing.js — duplicated so the
// rough-cut step can render a token-cost estimate the moment probeDuration
// resolves (sub-second after file pick), instead of waiting for the upload
// + /register + DB write before /estimate-ai-roughcut returns a non-zero
// value (the previous flow took ~30 s on Cloudflare Stream uploads).
//
// Drift risk is intentionally accepted for these 4 lines of policy: the
// server file is still the canonical source for the actual token deduction
// (rough-cut-runner.js); this copy only powers the UI preview. If the
// pricing formula changes, update both files together.
//
// The deduction-time minimum-1 floor stays in rough-cut-runner.js — this
// estimator returns 0 when duration is unknown so the existing "Calculating…"
// fallback keeps working when the probe hasn't completed yet.

export function estimateTokenCost(durationSeconds) {
  const minutes = (durationSeconds || 0) / 60
  return Math.ceil(minutes * 30) // 30 tokens per minute, 0 when no duration
}

export function estimateProcessingTime(durationSeconds) {
  const minutes = (durationSeconds || 0) / 60
  return Math.round(minutes * 0.375 * 60) // 0.375 min processing per min of video → seconds
}
