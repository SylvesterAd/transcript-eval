// One-shot migration: converts editor_state_json.broll.placements from
// original-time canonical to post-cut canonical. Attaches anchor_word_idx
// for stable identity. Idempotent via state.broll.schema_version === 'post-cut'.
//
// Run via: node --env-file=.env scripts/_migrate-placements-to-postcut.mjs
//
// The pure transform `migrateGroupState` is exported for unit tests; it
// reads no DB rows itself. (Note: importing `computeEffectiveCuts` from
// broll.js does pull db.js into the import graph and runs schema init at
// module load — same constraint as every other server-side test that
// imports broll.js.) The DB-touching `main()` only runs when this module
// is invoked directly (see ESM main-detection guard at the bottom).

import { computeEffectiveCuts } from '../server/services/broll.js'
import { postCutTime } from '../server/services/time-translation.js'
import { findAnchorWordIdx } from '../server/services/anchor-word.js'

/**
 * Migrate one group's editor_state_json.broll.placements in-place.
 *
 * @param {object} state - parsed editor_state_json
 * @param {Array} words - raw transcript word_timestamps for this group's main video
 * @returns {object} same `state` reference (mutated) with placements in post-cut format
 *
 * No-ops when:
 *  - state.broll is missing
 *  - state.broll.placements is missing/empty
 *  - state.broll.schema_version === 'post-cut' (already migrated)
 */
export function migrateGroupState(state, words) {
  if (!state?.broll?.placements?.length) return state
  if (state.broll.schema_version === 'post-cut') return state

  const cuts = state.cuts || []
  const exclusions = state.cutExclusions || []
  const effective = computeEffectiveCuts(cuts, exclusions)

  for (const p of state.broll.placements) {
    if (typeof p.start_seconds === 'number' && typeof p.end_seconds === 'number') {
      const newStart = postCutTime(p.start_seconds, effective)
      const newEnd = postCutTime(p.end_seconds, effective)
      p.start_seconds = newStart
      p.end_seconds = newEnd
    }
    if (p.anchor_word_idx == null && Array.isArray(words) && words.length) {
      p.anchor_word_idx = findAnchorWordIdx(words, p.audio_anchor)
    }
  }

  state.broll.schema_version = 'post-cut'
  return state
}

async function main() {
  // Defer db import to runtime so unit tests can import migrateGroupState
  // without paying the schema-init cost twice (broll.js → db.js already
  // pulls db.js into the import graph; but isolating main() here keeps
  // the surface clear for future refactors).
  const { default: db } = await import('../server/db.js')

  const groups = await db.prepare(
    "SELECT id, editor_state_json FROM video_groups WHERE editor_state_json IS NOT NULL"
  ).all()

  let scanned = 0, migrated = 0, skipped = 0, errored = 0

  for (const g of groups) {
    scanned++
    let state
    try { state = JSON.parse(g.editor_state_json) }
    catch (err) {
      console.warn(`[migrate] group ${g.id}: invalid JSON, skipping (${err.message})`)
      errored++
      continue
    }

    if (state?.broll?.schema_version === 'post-cut') {
      skipped++
      continue
    }
    if (!state?.broll?.placements?.length) {
      skipped++
      continue
    }

    // Load words for the main raw video
    const v = await db.prepare(
      "SELECT id FROM videos WHERE group_id = ? AND video_type = 'raw' LIMIT 1"
    ).get(g.id)
    let words = []
    if (v) {
      const t = await db.prepare(
        "SELECT word_timestamps_json FROM transcripts WHERE video_id = ? AND type = 'raw' LIMIT 1"
      ).get(v.id)
      if (t?.word_timestamps_json) {
        try { words = JSON.parse(t.word_timestamps_json) }
        catch { words = [] }
      }
    }

    const migratedState = migrateGroupState(state, words)
    await db.prepare(
      'UPDATE video_groups SET editor_state_json = ? WHERE id = ?'
    ).run(JSON.stringify(migratedState), g.id)
    migrated++
    console.log(`[migrate] group ${g.id}: migrated ${migratedState.broll.placements.length} placements`)
  }

  console.log(`\n[migrate] Done. scanned=${scanned} migrated=${migrated} skipped=${skipped} errored=${errored}`)
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error('[migrate] FAILED:', err); process.exit(1) })
}
