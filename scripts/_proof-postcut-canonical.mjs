// scripts/_proof-postcut-canonical.mjs
//
// Real-data round-trip proof for the post-cut canonical placement model.
//
// Loads project 273's cuts + word_timestamps. Simulates the full lifecycle:
//   1. Construct synthetic placements anchored to known transcript words
//      (in original-time, as if from a pre-migration broll plan)
//   2. Migrate to post-cut canonical (Task 7's migrateGroupState)
//   3. Verify each placement's post-cut time corresponds to where its
//      anchor_word_idx maps to in the post-cut domain
//   4. Apply a synthetic cut edit (add a new cut)
//   5. Re-run recomputePlacementsForCuts (Task 3 helper)
//   6. Verify the placements re-anchored cleanly (anchor_word_idx still
//      points to the same word; new post-cut time reflects the new cuts)
//   7. Translate post-cut → original via translatePlacementsForExport
//      (Task 11 helper) and verify the result matches the original-time
//      anchor positions
//
// Run via: node --env-file=.env scripts/_proof-postcut-canonical.mjs
// Exit code: 0 on full success, 1 on any failure.

import { readFileSync } from 'node:fs'
import { computeEffectiveCuts } from '../server/services/broll.js'
import { postCutTime, unshiftPostCutTime } from '../server/services/time-translation.js'
import { recomputePlacementsForCuts } from '../server/services/recompute-placement-times.js'
import { migrateGroupState } from './_migrate-placements-to-postcut.mjs'
import { translatePlacementsForExport } from '../server/routes/export-xml.js'

const fixture = JSON.parse(readFileSync(
  './server/services/__tests__/__fixtures__/project-273-cuts.json', 'utf8'
))
const cuts = fixture.editor_state.cuts
const exclusions = fixture.editor_state.cutExclusions || []
const words = fixture.word_timestamps
const effective = computeEffectiveCuts(cuts, exclusions)

console.log('═══ PROJECT 273 FIXTURE LOADED ═══')
console.log(`raw cuts: ${cuts.length}, effective: ${effective.length}, words: ${words.length}`)
console.log(`total cut span: ${effective.reduce((s,c) => s + (c.end - c.start), 0).toFixed(2)}s`)

let pass = 0, fail = 0
function check(name, actual, expected, tolerance = 0.001) {
  const ok = Math.abs(actual - expected) < tolerance
  if (ok) { pass++; console.log(`  ✓ ${name}: ${actual.toFixed(3)}`) }
  else    { fail++; console.log(`  ✗ ${name}: got ${actual} expected ~${expected} (Δ=${Math.abs(actual-expected).toFixed(3)})`) }
}
function checkEq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}: ${JSON.stringify(actual)}`) }
  else    { fail++; console.log(`  ✗ ${name}: got ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`) }
}

// ── Step 0: Pick anchor indices that are in KEPT content (not inside cuts) ──
// The fixture has a giant first cut [0, 134.08] and many smaller cuts;
// we pre-vetted these indices as KEPT (verified via ad-hoc check before
// authoring this script). Re-verify here so the script self-validates.
const anchorIndices = [509, 684, 870, 1056, 1235]
console.log('\n═══ Step 0: Verify anchor words are KEPT ═══')
for (const idx of anchorIndices) {
  const w = words[idx]
  const inCut = effective.some(c => w.start >= c.start && w.start < c.end)
  if (inCut) {
    console.error(`  ✗ word[${idx}] (start=${w.start}) is INSIDE a cut — pick a different index`)
    process.exit(1)
  }
  console.log(`  ✓ word[${idx}] = "${w.word}" start=${w.start.toFixed(2)} (kept)`)
}

// ── Step 1: Construct synthetic placements anchored to known words ──
console.log('\n═══ Step 1: Construct synthetic placements (original-time) ═══')
const placements = anchorIndices.map((idx, i) => {
  const w = words[idx]
  const anchorPhrase = words.slice(idx, idx + 3).map(x => x.word).join(' ')
  return {
    uuid: `p${i}`,
    audio_anchor: anchorPhrase,
    start_seconds: w.start,    // ORIGINAL TIME (pre-migration shape)
    end_seconds: w.start + 4,  // 4s placement
  }
})
console.log(`Built ${placements.length} placements anchored to words at indices ${anchorIndices.join(', ')}`)

// ── Step 2: Migrate to post-cut canonical ──
console.log('\n═══ Step 2: Migrate to post-cut canonical ═══')
const state = {
  cuts, cutExclusions: exclusions,
  broll: { placements: placements.map(p => ({ ...p })) },  // shallow copy each
}
const migrated = migrateGroupState(state, words)
checkEq('schema_version is post-cut', migrated.broll.schema_version, 'post-cut')
checkEq('all placements have anchor_word_idx >= 0', migrated.broll.placements.every(p => p.anchor_word_idx >= 0), true)
// Each anchor_word_idx should equal the index we constructed from
for (let i = 0; i < placements.length; i++) {
  checkEq(`placement ${i} anchor_word_idx`, migrated.broll.placements[i].anchor_word_idx, anchorIndices[i])
}

// Verify each placement's post-cut start matches postCutTime(original)
for (let i = 0; i < placements.length; i++) {
  const orig = placements[i]
  const post = migrated.broll.placements[i]
  const expectedPost = postCutTime(orig.start_seconds, effective)
  check(`placement ${i} (idx=${anchorIndices[i]}) post-cut start`, post.start_seconds, expectedPost)
}

// ── Step 3: Apply a synthetic cut edit (add a new 2s cut at [350, 352]) ──
// Chosen because the fixture has a clean kept gap [343.57, 365.72] of 22s,
// so this cut sits cleanly between existing cuts and doesn't merge.
// It lies AFTER anchors at idx 509 (189.96s), 684 (260.90s), 870 (330.22s),
// so those placements should be unaffected. It lies BEFORE idx 1056 (393.24s)
// and 1235 (464.08s), so those post-cut times shift by 2s.
console.log('\n═══ Step 3: Apply a cut edit (add a 2s cut at [350, 352]) ═══')
const newCuts = [...cuts, { id: 'manual-test', start: 350, end: 352, source: 'manual' }]
const newEffective = computeEffectiveCuts(newCuts, exclusions)
console.log(`new effective cuts: ${newEffective.length} (was ${effective.length})`)
console.log(`new total cut span: ${newEffective.reduce((s,c) => s + (c.end - c.start), 0).toFixed(2)}s (was ${effective.reduce((s,c) => s + (c.end - c.start), 0).toFixed(2)}s)`)

// ── Step 4: Recompute placement post-cut times under new cuts ──
console.log('\n═══ Step 4: Recompute placements under new cuts ═══')
const recomputed = recomputePlacementsForCuts(migrated.broll.placements, newCuts, exclusions, words)
checkEq('recomputed all placements have anchor_word_idx', recomputed.every(p => p.anchor_word_idx >= 0), true)
checkEq('no placement marked anchor_in_cut', recomputed.every(p => !p.anchor_in_cut), true)
checkEq('no placement marked anchor_orphaned', recomputed.every(p => !p.anchor_orphaned), true)

// Verify each placement's NEW post-cut start matches postCutTime under newCuts
for (let i = 0; i < recomputed.length; i++) {
  const w = words[recomputed[i].anchor_word_idx]
  const expectedPost = postCutTime(w.start, newEffective)
  check(`placement ${i} (idx=${anchorIndices[i]}) post-cut start under new cuts`, recomputed[i].start_seconds, expectedPost)
  // Duration preserved
  const dur = recomputed[i].end_seconds - recomputed[i].start_seconds
  check(`placement ${i} duration preserved`, dur, 4)
}

// Bonus assertion: placements before the new cut (anchors at start < 350)
// should have unchanged post-cut start; placements after (start >= 352)
// should have shifted by the new cut's 2s span.
console.log('\n  Sub-check: shift behaviour around the new [350, 352] cut')
for (let i = 0; i < recomputed.length; i++) {
  const wOrig = words[anchorIndices[i]]
  const before = migrated.broll.placements[i].start_seconds
  const after = recomputed[i].start_seconds
  const delta = after - before
  if (wOrig.start < 350) {
    check(`  placement ${i} (idx=${anchorIndices[i]}, orig=${wOrig.start.toFixed(2)}) unchanged`, delta, 0)
  } else {
    // Expected delta == -(new cut span) since adding a cut SHRINKS post-cut time
    check(`  placement ${i} (idx=${anchorIndices[i]}, orig=${wOrig.start.toFixed(2)}) shifted by -2s`, delta, -2)
  }
}

// ── Step 5: Translate post-cut → original via export helper ──
console.log('\n═══ Step 5: Translate to original-time for XMEML export ═══')
// translatePlacementsForExport expects timelineStart/timelineDuration shape
const placementsForExport = recomputed.map((p) => ({
  uuid: p.uuid,
  timelineStart: p.start_seconds,
  timelineDuration: p.end_seconds - p.start_seconds,
}))
const translated = translatePlacementsForExport(placementsForExport, newEffective)

// Each translated placement's timelineStart should equal unshiftPostCutTime(post-cut)
for (let i = 0; i < translated.length; i++) {
  const expectedOrig = unshiftPostCutTime(recomputed[i].start_seconds, newEffective, 'start')
  check(`translated ${i} original-time start`, translated[i].timelineStart, expectedOrig)
}

// ── Step 6: Cross-check against original anchor word positions ──
// For kept content (anchor not inside any cut), the round-trip identity
// postCutTime ∘ unshiftPostCutTime = id holds, so the translated start
// must match the original anchor word's start time.
console.log('\n═══ Step 6: Cross-check translated original-time matches anchor word ═══')
for (let i = 0; i < translated.length; i++) {
  const w = words[recomputed[i].anchor_word_idx]
  const isKept = !newEffective.some(c => w.start >= c.start && w.start < c.end)
  if (isKept) {
    check(`translated ${i} matches original anchor word start (kept)`, translated[i].timelineStart, w.start, 0.01)
  } else {
    console.log(`  · placement ${i} anchor word inside cut — translation may not be invertible`)
  }
}

console.log(`\n═══ TOTAL: ${pass} passed, ${fail} failed ═══`)
process.exit(fail === 0 ? 0 : 1)
