// B-Roll export service. Phase 1 responsibilities:
// - mint export IDs (ULID with `exp_` prefix, lex-sortable by time)
// - create/update exports rows
// - insert export_events rows
// - fire Slack alerts on a dedupe window for the event types listed in
//   docs/specs/2026-04-23-envato-export-design.md § Slack alerting.

import { ulid } from 'ulid'
// used by upcoming tasks (Tasks 4–6):
// import db from '../db.js'
// import { notify } from './slack-notifier.js'

export function mintExportId() {
  return `exp_${ulid()}`
}
