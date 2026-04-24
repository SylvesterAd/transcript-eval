// Ext.6 telemetry — /api/export-events emitter with offline queue +
// exponential-backoff retry.
//
// This module is the singleton owner of the telemetry buffer + flush
// loop. MV3 SW termination means the in-memory ring buffer is LOST on
// shutdown unless persisted — Task 2 wires the persist path; Task 3
// wires the flush loop + retry.
//
// Public API:
//   emit(event, payload)            — fire-and-forget; returns void
//   flushNow()                      — debug/test helper; forces one
//                                     flush attempt immediately
//   pauseForAuthRefresh()           — auth.js calls this on 401
//   resumeAfterAuthRefresh()        — auth.js calls this after refresh
//   getBufferStats()                — {buffer_size, queue_size,
//                                     paused_for_auth, overflow_total}
//
// See docs/superpowers/plans/2026-04-24-extension-ext6-telemetry.md
// for the full "Why read this before touching code" invariants — do
// not ship changes to this file without re-reading them.

export function emit(_event, _payload) {
  // Task 2 fills this in.
}

export async function flushNow() {
  // Task 3 fills this in.
}

export function pauseForAuthRefresh() {
  // Task 3 fills this in.
}

export function resumeAfterAuthRefresh() {
  // Task 3 fills this in.
}

export function getBufferStats() {
  // Task 3 fills this in.
  return { buffer_size: 0, queue_size: 0, paused_for_auth: false, overflow_total: 0 }
}
