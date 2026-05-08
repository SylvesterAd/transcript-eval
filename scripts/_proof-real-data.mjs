// Real-data proof: apply Phase A's chokepoint to the actual per-chapter plan
// output from project 293's smoke run. Demonstrates the un-shift math fires
// correctly on production-shaped data.

import { readFileSync } from 'node:fs'
import {
  unshiftPostCutTime,
  remapPlacementTimes,
  remapPlacementTimesString,
  parseTimecodeString,
  formatTimecodeString,
  persistPlacementOutput,
  computeEffectiveCuts,
} from '../server/services/broll.js'

// Helper for asserting + reporting
let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`) }
}

console.log('═══ FEATURE: unshiftPostCutTime + asymmetric boundary rule ═══')
{
  const cuts = [{ start: 60, end: 80 }] // 20s cut
  // Pre-cut point: identity
  check('identity for t before any cut',
    unshiftPostCutTime(50, cuts, 'start'), 50)
  // Post-cut point: shifts
  check('post-cut t=100 → original 120 (start kind)',
    unshiftPostCutTime(100, cuts, 'start'), 120)
  // Boundary: start kind jumps PAST cut
  check("boundary t=60 with kind='start' → cut.end=80",
    unshiftPostCutTime(60, cuts, 'start'), 80)
  // Boundary: end kind stays BEFORE cut
  check("boundary t=60 with kind='end' → cut.start=60",
    unshiftPostCutTime(60, cuts, 'end'), 60)
  // No cuts: identity
  check('no cuts, start kind: identity', unshiftPostCutTime(42, [], 'start'), 42)
  check('no cuts, end kind: identity', unshiftPostCutTime(42, [], 'end'), 42)
}

console.log('\n═══ FEATURE: parseTimecodeString / formatTimecodeString ═══')
{
  check('parse [00:05:09] → 309', parseTimecodeString('[00:05:09]'), 309)
  check('parse [00:05:09.50] → 309.5', parseTimecodeString('[00:05:09.50]'), 309.5)
  check('format 309 → [00:05:09]', formatTimecodeString(309), '[00:05:09]')
  check('format 309.5 → [00:05:09.50]', formatTimecodeString(309.5), '[00:05:09.50]')
  check('parse garbage → null', parseTimecodeString('not a tc'), null)
  // Round-trip
  const seconds = [0, 1.25, 60, 309, 3661.99]
  for (const s of seconds) {
    check(`round-trip ${s}s`, parseTimecodeString(formatTimecodeString(s)), s === 3661.99 ? 3661.99 : s)
  }
}

console.log('\n═══ FEATURE: remapPlacementTimesString (string format) ═══')
{
  const cuts = [{ start: 60, end: 80 }]
  const placements = [
    { start: '[00:00:50]', end: '[00:00:55]', description: 'before cut' },
    { start: '[00:05:09]', end: '[00:05:15]', description: 'after cut' },
  ]
  const out = remapPlacementTimesString(placements, cuts)
  check('before cut: timecodes unchanged', out[0].start, '[00:00:50]')
  check('before cut: end unchanged', out[0].end, '[00:00:55]')
  // 309s post-cut → 329s original (309 + 20s shift)
  check('after cut: 5:09 → 5:29 (un-shifted +20s)', out[1].start, '[00:05:29]')
  check('after cut: 5:15 → 5:35 (un-shifted +20s)', out[1].end, '[00:05:35]')
  check('non-time fields preserved', out[1].description, 'after cut')
}

console.log('\n═══ FEATURE: persistPlacementOutput chokepoint — REAL DATA ═══')
{
  // Load real plan output from project 293
  const realOutput = readFileSync('/tmp/plan_4079.txt', 'utf8')
  console.log(`  Loaded real plan output (${realOutput.length} chars)`)

  // Case 1: no cuts — chokepoint is a no-op
  const noOp = await persistPlacementOutput(realOutput, null)
  check('no editorCuts: returns input unchanged', noOp, realOutput)

  // Case 2: empty cuts array — also no-op
  const emptyCuts = await persistPlacementOutput(realOutput, { cuts: [], cutExclusions: [] })
  check('editorCuts.cuts=[]: returns input unchanged', emptyCuts, realOutput)

  // Case 3: synthetic cut [60, 80] — should un-shift placements >60s by +20s
  const cuts = { cuts: [{ start: 60, end: 80 }], cutExclusions: [] }
  const shifted = await persistPlacementOutput(realOutput, cuts)
  // Parse and inspect the first few placements
  const parsedShifted = JSON.parse(shifted)
  const parsedOriginal = JSON.parse(realOutput.replace(/^```json\s*/, '').replace(/\s*```\s*$/, ''))
  console.log(`  Original: ${parsedOriginal.placements.length} placements (first start=${parsedOriginal.placements[0].start})`)
  console.log(`  Shifted:  ${parsedShifted.placements.length} placements (first start=${parsedShifted.placements[0].start})`)

  // First placement starts at [00:04:58] = 298s — AFTER the cut [60,80] in post-cut time.
  // So unshift should give 298 + 20 = 318 = [00:05:18]
  check('first placement: [00:04:58] → [00:05:18] (un-shifted +20s)',
    parsedShifted.placements[0].start, '[00:05:18]')
  check('first placement end: [00:05:03] → [00:05:23]',
    parsedShifted.placements[0].end, '[00:05:23]')

  // Total placement count preserved
  check('placement count preserved', parsedShifted.placements.length, parsedOriginal.placements.length)
  // Non-time fields preserved
  check('audio_anchor preserved on first placement',
    parsedShifted.placements[0].audio_anchor, parsedOriginal.placements[0].audio_anchor)
  check('beat preserved', parsedShifted.placements[0].beat, parsedOriginal.placements[0].beat)
  check('description preserved',
    parsedShifted.placements[0].description, parsedOriginal.placements[0].description)
  check('total_placements preserved', parsedShifted.total_placements, parsedOriginal.total_placements)
}

console.log('\n═══ FEATURE: persistPlacementOutput — chapters wrapper shape ═══')
{
  const editorCuts = { cuts: [{ start: 60, end: 80 }], cutExclusions: [] }
  // {chapters: [{placements: [string format]}]} — the assemble_broll_plan shape
  const wrapped = JSON.stringify({
    video_context: 'test',
    total_chapters: 1,
    chapters: [
      {
        chapter_number: 1,
        placements: [
          { start: '[00:05:00]', end: '[00:05:10]', description: 'a' },
        ],
      },
    ],
  })
  const out = await persistPlacementOutput(wrapped, editorCuts)
  const parsed = JSON.parse(out)
  check('chapters wrapper: placement un-shifted (300→320)',
    parsed.chapters[0].placements[0].start, '[00:05:20]')
  check('chapters wrapper: numeric shape also handled (back-compat)',
    (await persistPlacementOutput(JSON.stringify({
      chapters: [{ placements: [{ start_seconds: 100, end_seconds: 110 }] }],
    }), editorCuts)),
    JSON.stringify({
      chapters: [{ placements: [{ start_seconds: 120, end_seconds: 130 }] }],
    }, null, 2),
  )
}

console.log('\n═══ FEATURE: Round-trip identity (project 273 fixture) ═══')
{
  // Load the project 273 fixture from Task 7
  const fixture = JSON.parse(readFileSync(
    '/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/cuts-as-source-of-truth/server/services/__tests__/__fixtures__/project-273-cuts.json',
    'utf8'
  ))
  const cuts = fixture.editor_state?.cuts || []
  const cutExclusions = fixture.editor_state?.cutExclusions || []
  const words = fixture.word_timestamps || []
  const effective = computeEffectiveCuts(cuts, cutExclusions)
  console.log(`  Project 273: ${cuts.length} raw cuts, ${effective.length} effective cuts, ${words.length} words`)

  let checked = 0, drift = 0
  for (const w of words) {
    const mid = (w.start + w.end) / 2
    const inCut = effective.some(c => mid >= c.start && mid < c.end)
    if (inCut) continue
    // Forward shift (mirror of getOffset)
    let cumOffset = 0
    for (const c of effective) {
      if (c.end <= w.start) cumOffset += c.end - c.start
      else break
    }
    const shifted = w.start - cumOffset
    const roundtrip = unshiftPostCutTime(shifted, effective, 'start')
    if (Math.abs(roundtrip - w.start) > drift) drift = Math.abs(roundtrip - w.start)
    checked++
  }
  check(`round-trip identity over ${checked} kept words`, drift < 0.001, true)
  console.log(`  Max drift: ${drift.toExponential(2)}s (well below 1ms tolerance)`)
}

console.log('\n═══ TOTAL ═══')
console.log(`  ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
