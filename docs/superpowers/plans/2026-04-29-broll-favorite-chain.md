# B-Roll Favorite-First Strategy Chain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Working directory:** `/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/broll-audience/`
**Branch:** `feature/broll-audience-placeholder`
**Spec:** [docs/specs/2026-04-29-broll-favorite-chain-design.md](../../specs/2026-04-29-broll-favorite-chain-design.md)
**Verify CWD before starting any task:** `pwd` should print the worktree path above.

**Goal:** Sequence non-favorite reference videos' b-roll strategies in a chain after the Favorite's strategy completes, injecting prior chapter+beat strategies into each variant's per-chapter prompt with a "do not produce a similar strategy" directive. Combined strategy keeps current parallel behavior.

**Architecture:** New testable module `broll-prior-strategies.js` holds the slim formatter, the per-chapter loader, and the integrity-guard helpers. `executeCreateStrategy` gains a `priorStrategyPipelineIds` parameter that, when non-empty, triggers per-chapter substitution of `{{prior_chapter_strategies}}`. `runStrategies()` reorders analysis IDs (favorite first), reserves all pipeline IDs upfront, fires Favorite + Combined immediately, and spawns one fire-and-forget chain that awaits Favorite then sequentially fires Variants with growing prior lists.

**Tech Stack:** Node.js + Express server, vitest for tests, Postgres-backed SQL (`db.prepare(...).get(...)` pattern), in-memory `brollPipelineProgress` Map for pipeline lifecycle.

---

## File Structure

| Action | Path | Responsibility |
|---|---|---|
| Create | `server/services/broll-prior-strategies.js` | `slimChapterStrategy`, `loadPriorChapterStrategies`, `assertNoSelfReference`, `assertPriorsComplete` |
| Create | `server/services/__tests__/broll-prior-strategies.test.js` | Unit tests for all four exports |
| Modify | `server/services/broll.js` | `executeCreateStrategy` gains `priorStrategyPipelineIds` param; per-chapter substitution wired |
| Modify | `server/services/broll-runner.js` | `runStrategies()` reorders + spawns chain |
| Modify | `server/seed/update-create-strategy-beat-first.js` | Step 5 prompt gets `{{prior_chapter_strategies}}` + directive at the top |

---

## Task 1: Slim chapter strategy formatter (TDD)

**Files:**
- Create: `server/services/broll-prior-strategies.js`
- Create: `server/services/__tests__/broll-prior-strategies.test.js`

- [ ] **Step 1.1: Verify CWD**

```bash
pwd
```
Expected: `/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/broll-audience`

- [ ] **Step 1.2: Write the failing tests**

Create `server/services/__tests__/broll-prior-strategies.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import { slimChapterStrategy } from '../broll-prior-strategies.js'

describe('slimChapterStrategy', () => {
  it('returns empty string for null/undefined/non-string input', () => {
    expect(slimChapterStrategy(null)).toBe('')
    expect(slimChapterStrategy(undefined)).toBe('')
    expect(slimChapterStrategy('')).toBe('')
    expect(slimChapterStrategy(42)).toBe('')
  })

  it('keeps strategy + beat_strategies, drops bookkeeping fields', () => {
    const input = JSON.stringify({
      matched_reference_chapter: { chapter_name: 'X', match_reason: 'Y' },
      frequency_targets: { broll: { target_per_minute: 13 } },
      strategy: { commonalities: 'pacing X', broll: { sources: 'mixed' } },
      beat_strategies: [{ beat_name: 'Hook', strategy_points: ['close-up'] }],
    })
    const parsed = JSON.parse(slimChapterStrategy(input))
    expect(parsed.strategy).toEqual({ commonalities: 'pacing X', broll: { sources: 'mixed' } })
    expect(parsed.beat_strategies).toHaveLength(1)
    expect(parsed.beat_strategies[0].beat_name).toBe('Hook')
    expect(parsed.matched_reference_chapter).toBeUndefined()
    expect(parsed.frequency_targets).toBeUndefined()
  })

  it('handles missing strategy or beat_strategies fields with safe defaults', () => {
    const out = JSON.parse(slimChapterStrategy(JSON.stringify({ frequency_targets: {} })))
    expect(out.strategy).toBeNull()
    expect(out.beat_strategies).toEqual([])
  })

  it('parses JSON wrapped in markdown fence', () => {
    const input = '```json\n{"strategy":"X","beat_strategies":[]}\n```'
    const out = JSON.parse(slimChapterStrategy(input))
    expect(out.strategy).toBe('X')
  })

  it('parses JSON wrapped in extra prose (forgiving)', () => {
    const input = 'Here is the JSON: {"strategy":"X","beat_strategies":[]} thanks'
    const out = JSON.parse(slimChapterStrategy(input))
    expect(out.strategy).toBe('X')
  })

  it('falls back to truncated raw text on totally unparseable input', () => {
    const input = 'no json here just text ' + 'x'.repeat(3000)
    const out = slimChapterStrategy(input)
    expect(out.length).toBeLessThanOrEqual(2000)
    expect(out.startsWith('no json here')).toBe(true)
  })
})
```

- [ ] **Step 1.3: Run tests; expect FAIL (module not found)**

```bash
npx vitest --run server/services/__tests__/broll-prior-strategies.test.js
```
Expected: error like `Failed to load url ../broll-prior-strategies.js`

- [ ] **Step 1.4: Implement `slimChapterStrategy`**

Create `server/services/broll-prior-strategies.js`:

```javascript
// Reduces a per-chapter strategy LLM output to "Chapter + Beats strategy" — the
// chapter-level strategy block and per-beat strategies. Drops bookkeeping
// fields (matched_reference_chapter, frequency_targets) so the slim text is
// focused on what the LLM is asked NOT to copy.
export function slimChapterStrategy(rawJsonText) {
  if (!rawJsonText || typeof rawJsonText !== 'string') return ''
  let parsed = tryParse(rawJsonText)
  if (!parsed) {
    const fence = rawJsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) parsed = tryParse(fence[1].trim())
  }
  if (!parsed) {
    const m = rawJsonText.match(/\{[\s\S]*\}/)
    if (m) parsed = tryParse(m[0])
  }
  if (!parsed || typeof parsed !== 'object') return rawJsonText.slice(0, 2000)
  const slim = {
    strategy: parsed.strategy ?? null,
    beat_strategies: parsed.beat_strategies ?? [],
  }
  return JSON.stringify(slim, null, 2)
}

function tryParse(text) {
  try { return JSON.parse(text) } catch { return null }
}
```

- [ ] **Step 1.5: Run tests; expect PASS**

```bash
npx vitest --run server/services/__tests__/broll-prior-strategies.test.js
```
Expected: `Tests  6 passed (6)`

- [ ] **Step 1.6: Commit**

```bash
git add server/services/broll-prior-strategies.js server/services/__tests__/broll-prior-strategies.test.js
git commit -m "$(cat <<'EOF'
feat(broll): add slimChapterStrategy formatter for prior-chain injection

Reduces a per-chapter strategy LLM output to chapter strategy + beat
strategies, dropping matched_reference_chapter and frequency_targets
bookkeeping. Used by the upcoming favorite-first chain to inject prior
strategies into variant prompts. Module is standalone for unit testing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `loadPriorChapterStrategies` loader (TDD)

**Files:**
- Modify: `server/services/broll-prior-strategies.js`
- Modify: `server/services/__tests__/broll-prior-strategies.test.js`

- [ ] **Step 2.1: Append failing tests**

Append at the bottom of `server/services/__tests__/broll-prior-strategies.test.js`:

```javascript
import { vi, beforeEach } from 'vitest'
import { loadPriorChapterStrategies } from '../broll-prior-strategies.js'

vi.mock('../../db.js', () => ({
  default: { prepare: vi.fn() },
}))
import db from '../../db.js'

describe('loadPriorChapterStrategies', () => {
  beforeEach(() => { db.prepare.mockReset() })

  it('returns empty string when priors array is empty/undefined/null', async () => {
    expect(await loadPriorChapterStrategies([], 0)).toBe('')
    expect(await loadPriorChapterStrategies(undefined, 0)).toBe('')
    expect(await loadPriorChapterStrategies(null, 0)).toBe('')
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('throws when sub-run is missing for a prior pipeline + chapter', async () => {
    db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue(undefined) })
    await expect(loadPriorChapterStrategies(['pid-x'], 2))
      .rejects.toThrow('missing sub-run: pid=pid-x chapter=2')
  })

  it('formats single prior with directive header + reference title', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: JSON.stringify({
          strategy: { commonalities: 'X' },
          beat_strategies: [{ beat_name: 'Hook' }],
        }),
        video_id: 5,
        title: 'My Reference Video',
      }),
    })
    const out = await loadPriorChapterStrategies(['pid-1'], 0)
    expect(out).toContain('## Prior strategies for this chapter (do NOT produce a similar strategy):')
    expect(out).toContain('=== Source: Reference: My Reference Video ===')
    expect(out).toContain('"beat_name": "Hook"')
    expect(out).toContain('"commonalities": "X"')
  })

  it('uses pid as fallback label when video has no title', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn().mockReturnValue({
        output_text: '{"strategy":null,"beat_strategies":[]}',
        video_id: 5,
        title: null,
      }),
    })
    const out = await loadPriorChapterStrategies(['pid-fallback'], 0)
    expect(out).toContain('=== Source: pid-fallback ===')
  })

  it('two priors → two blocks in pipeline-id order separated by blank line', async () => {
    let callCount = 0
    db.prepare.mockReturnValue({
      get: vi.fn(() => {
        callCount++
        return {
          output_text: JSON.stringify({ strategy: `s${callCount}`, beat_strategies: [] }),
          video_id: callCount,
          title: `Ref ${callCount}`,
        }
      }),
    })
    const out = await loadPriorChapterStrategies(['p1', 'p2'], 0)
    expect(out.indexOf('Ref 1')).toBeLessThan(out.indexOf('Ref 2'))
    const blocks = out.split('=== Source:')
    expect(blocks).toHaveLength(3) // header + 2 source blocks
  })
})
```

- [ ] **Step 2.2: Run tests; expect FAIL (loadPriorChapterStrategies undefined)**

```bash
npx vitest --run server/services/__tests__/broll-prior-strategies.test.js
```
Expected: 5 failures referencing `loadPriorChapterStrategies is not a function`

- [ ] **Step 2.3: Implement `loadPriorChapterStrategies`**

Append to `server/services/broll-prior-strategies.js`:

```javascript
import db from '../db.js'

// For each prior strategy pipeline, fetch its chapter-N sub-run from
// broll_runs, slim the output, and concatenate into one block prefixed with
// the "do NOT produce a similar strategy" directive. Returns '' when the
// prior list is empty (favorite case). Throws on any missing sub-run so the
// caller fails loudly rather than sending an under-specified prompt.
export async function loadPriorChapterStrategies(priorPids, chapterIndex) {
  if (!priorPids?.length) return ''
  const blocks = []
  for (const pid of priorPids) {
    const subRun = await db.prepare(
      `SELECT br.output_text, br.video_id, v.title FROM broll_runs br
       LEFT JOIN videos v ON v.id = br.video_id
       WHERE br.metadata_json LIKE ?
         AND br.metadata_json LIKE ?
         AND br.metadata_json LIKE '%"isSubRun":true%'
         AND br.status = 'complete'
       ORDER BY br.id DESC LIMIT 1`
    ).get(`%"pipelineId":"${pid}"%`, `%"subIndex":${chapterIndex}%`)
    if (!subRun) {
      throw new Error(`[broll-chain] missing sub-run: pid=${pid} chapter=${chapterIndex}`)
    }
    const slim = slimChapterStrategy(subRun.output_text)
    const label = subRun.title ? `Reference: ${subRun.title}` : pid
    blocks.push(`=== Source: ${label} ===\n${slim}`)
  }
  return `## Prior strategies for this chapter (do NOT produce a similar strategy):\n${blocks.join('\n\n')}`
}
```

- [ ] **Step 2.4: Run tests; expect PASS**

```bash
npx vitest --run server/services/__tests__/broll-prior-strategies.test.js
```
Expected: `Tests  11 passed (11)`

- [ ] **Step 2.5: Commit**

```bash
git add server/services/broll-prior-strategies.js server/services/__tests__/broll-prior-strategies.test.js
git commit -m "$(cat <<'EOF'
feat(broll): add loadPriorChapterStrategies for chain injection

For each prior strategy pipeline, fetches its chapter-N sub-run from
broll_runs, slims it, and concatenates into a directive-headed block
ready to be substituted into a variant's per-chapter prompt. Throws
on missing sub-runs so the caller fails loudly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Integrity guard helpers (TDD)

**Files:**
- Modify: `server/services/broll-prior-strategies.js`
- Modify: `server/services/__tests__/broll-prior-strategies.test.js`

- [ ] **Step 3.1: Append failing tests**

Append at the bottom of the test file:

```javascript
import { assertNoSelfReference, assertPriorsComplete } from '../broll-prior-strategies.js'

describe('assertNoSelfReference', () => {
  it('returns nothing when pipelineId is not in priors', () => {
    expect(() => assertNoSelfReference('pid-current', ['pid-favorite', 'pid-other'])).not.toThrow()
  })

  it('returns nothing when priors is empty/undefined', () => {
    expect(() => assertNoSelfReference('pid-current', [])).not.toThrow()
    expect(() => assertNoSelfReference('pid-current', undefined)).not.toThrow()
  })

  it('throws when pipelineId appears in priors', () => {
    expect(() => assertNoSelfReference('pid-x', ['pid-favorite', 'pid-x']))
      .toThrow('self-reference: pid-x cannot have itself as prior')
  })
})

describe('assertPriorsComplete', () => {
  beforeEach(() => { db.prepare.mockReset() })

  it('returns nothing when priors is empty/undefined', async () => {
    await expect(assertPriorsComplete([])).resolves.toBeUndefined()
    await expect(assertPriorsComplete(undefined)).resolves.toBeUndefined()
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('returns nothing when every prior has a complete row in broll_runs', async () => {
    db.prepare.mockReturnValue({ get: vi.fn().mockReturnValue({ '1': 1 }) })
    await expect(assertPriorsComplete(['pid-a', 'pid-b'])).resolves.toBeUndefined()
  })

  it('throws when any prior has zero complete rows', async () => {
    db.prepare.mockReturnValue({
      get: vi.fn()
        .mockReturnValueOnce({ '1': 1 })
        .mockReturnValueOnce(undefined),
    })
    await expect(assertPriorsComplete(['pid-a', 'pid-missing']))
      .rejects.toThrow('prior pipeline not complete: pid-missing')
  })
})
```

- [ ] **Step 3.2: Run tests; expect FAIL**

```bash
npx vitest --run server/services/__tests__/broll-prior-strategies.test.js
```
Expected: 7 failures (functions not exported)

- [ ] **Step 3.3: Implement guards**

Append to `server/services/broll-prior-strategies.js`:

```javascript
export function assertNoSelfReference(pipelineId, priorPids) {
  if (priorPids?.includes(pipelineId)) {
    throw new Error(`[broll-chain] self-reference: ${pipelineId} cannot have itself as prior`)
  }
}

export async function assertPriorsComplete(priorPids) {
  if (!priorPids?.length) return
  for (const pid of priorPids) {
    const ok = await db.prepare(
      `SELECT 1 FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' LIMIT 1`
    ).get(`%"pipelineId":"${pid}"%`)
    if (!ok) throw new Error(`[broll-chain] prior pipeline not complete: ${pid}`)
  }
}
```

- [ ] **Step 3.4: Run tests; expect PASS**

```bash
npx vitest --run server/services/__tests__/broll-prior-strategies.test.js
```
Expected: `Tests  18 passed (18)`

- [ ] **Step 3.5: Commit**

```bash
git add server/services/broll-prior-strategies.js server/services/__tests__/broll-prior-strategies.test.js
git commit -m "$(cat <<'EOF'
feat(broll): add chain integrity guards (self-ref + priors-complete)

assertNoSelfReference throws if a variant's pipelineId appears in its
own priors list. assertPriorsComplete confirms via broll_runs that each
prior pipeline produced at least one complete row before the variant
fires. Both fail loudly per the chain design's data-integrity rules.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `executeCreateStrategy` to accept priors and substitute

**Files:**
- Modify: `server/services/broll.js` (function `executeCreateStrategy` starting at line 2388)

- [ ] **Step 4.1: Read the current function signature**

```bash
grep -n "^export async function executeCreateStrategy" server/services/broll.js
```
Expected: `2388:export async function executeCreateStrategy(prepPipelineId, analysisPipelineId, videoId, groupId, pipelineIdOverride) {`

- [ ] **Step 4.2: Add the import for the new helpers at the top of broll.js**

Find the existing import block near the top of `server/services/broll.js`. Add:

```javascript
import {
  loadPriorChapterStrategies,
  assertNoSelfReference,
  assertPriorsComplete,
} from './broll-prior-strategies.js'
```

(The `formatAudience` import from the earlier audience commit is already present nearby — append the new import below it.)

- [ ] **Step 4.3: Add the new parameter and top-of-function guards**

Use the Edit tool to change the signature and the early section of the function. Find:

```javascript
export async function executeCreateStrategy(prepPipelineId, analysisPipelineId, videoId, groupId, pipelineIdOverride) {
  // 1. Load create_strategy strategy and version
  const strategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'create_strategy' ORDER BY id LIMIT 1").get()
  if (!strategy) throw new Error('No create_strategy strategy found')
  const version = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy.id)
  if (!version) throw new Error('No create_strategy version found')
  const stages = JSON.parse(version.stages_json || '[]')
  if (!stages.length) throw new Error('create_strategy strategy has no stages')
```

Replace with:

```javascript
export async function executeCreateStrategy(prepPipelineId, analysisPipelineId, videoId, groupId, pipelineIdOverride, priorStrategyPipelineIds = []) {
  // 1. Load create_strategy strategy and version
  const strategy = await db.prepare("SELECT * FROM broll_strategies WHERE strategy_kind = 'create_strategy' ORDER BY id LIMIT 1").get()
  if (!strategy) throw new Error('No create_strategy strategy found')
  const version = await db.prepare('SELECT * FROM broll_strategy_versions WHERE strategy_id = ? ORDER BY created_at DESC LIMIT 1').get(strategy.id)
  if (!version) throw new Error('No create_strategy version found')
  const stages = JSON.parse(version.stages_json || '[]')
  if (!stages.length) throw new Error('create_strategy strategy has no stages')

  // Chain integrity: variant cannot reference itself, and every prior must
  // have completed before we run. Logs upfront so a paste-able trail exists
  // for production debugging.
  assertNoSelfReference(pipelineIdOverride, priorStrategyPipelineIds)
  await assertPriorsComplete(priorStrategyPipelineIds)
  console.log(`[broll-chain] executeCreateStrategy ${pipelineIdOverride || '(no-override)'} priors=[${priorStrategyPipelineIds.join(',')}]`)
```

- [ ] **Step 4.4: Add per-chapter substitution**

Find the per-chapter loop in `executeCreateStrategy`. Locate the lines where `chPrompt` and `chSystem` are built (search for `let chPrompt = replacePlaceholders(stage.prompt`):

```bash
grep -n "let chPrompt = replacePlaceholders(stage.prompt" server/services/broll.js
```

The hit inside `executeCreateStrategy` is around line 2573. Read 30 lines starting there to find the `chSystem` line and the LLM call that follows, then insert AFTER `chSystem` is built but BEFORE the LLM call:

```javascript
const priorChapterText = await loadPriorChapterStrategies(priorStrategyPipelineIds, c)
if (priorStrategyPipelineIds.length > 0 && !priorChapterText) {
  throw new Error(`[broll-chain] expected non-empty priors text for chapter ${c}, got empty`)
}
chPrompt = chPrompt.replace(/\{\{prior_chapter_strategies\}\}/g, priorChapterText)
chSystem = chSystem.replace(/\{\{prior_chapter_strategies\}\}/g, priorChapterText)
console.log(`[broll-chain] variant ${pipelineIdOverride || '(no-override)'} chapter ${c} injecting priors n=${priorStrategyPipelineIds.length} bytes=${priorChapterText.length}`)
```

Note: `chPrompt` is `let` (mutable). If `chSystem` is currently declared with `const`, change it to `let` so the new `.replace` reassignment compiles.

- [ ] **Step 4.5: Run vitest to confirm nothing broke**

```bash
npx vitest --run --reporter=basic 2>&1 | tail -8
```
Expected: same 10 pre-existing failures (auto-orchestrator + broll-runner + StepRoughCut), all 18 prior-strategies tests pass, total passing count = 305 + 18 = 323.

- [ ] **Step 4.6: Commit**

```bash
git add server/services/broll.js
git commit -m "$(cat <<'EOF'
feat(broll): executeCreateStrategy accepts priorStrategyPipelineIds

Adds new optional parameter (defaults to []) that, when non-empty,
substitutes {{prior_chapter_strategies}} in both prompt and
system_instruction with the chain-formatted slim text from prior
pipelines for the current chapter. Includes self-reference guard,
priors-complete DB confirmation, per-chapter non-empty assertion, and
structured [broll-chain] logging at every handoff.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire favorite-first chain in `runStrategies`

**Files:**
- Modify: `server/services/broll-runner.js` (function `runStrategies` at line 127)

- [ ] **Step 5.1: Read the current `runStrategies`**

```bash
sed -n '127,202p' server/services/broll-runner.js
```
Expected: function body matching the spec's "before" state.

- [ ] **Step 5.2: Replace the function body with chain orchestration**

Use the Edit tool. Find this block (full function body from `runStrategies({...}) {` through `return { strategyPipelineIds: allPipelineIds, combinedPipelineId }`) and replace it.

Old block (search anchor):

```javascript
export async function runStrategies({ subGroupId, mainVideoId, prepPipelineId, analysisPipelineIds }) {
  if (!prepPipelineId || !analysisPipelineIds?.length || !mainVideoId) {
    throw new Error('runStrategies: prepPipelineId, analysisPipelineIds, and mainVideoId required')
  }
  const { executeCreateStrategy, executeCreateCombinedStrategy, brollPipelineProgress } =
    await import('./broll.js')
```

Keep the parameter destructuring and the imports; replace the body that follows. Final function body should look like:

```javascript
export async function runStrategies({ subGroupId, mainVideoId, prepPipelineId, analysisPipelineIds }) {
  if (!prepPipelineId || !analysisPipelineIds?.length || !mainVideoId) {
    throw new Error('runStrategies: prepPipelineId, analysisPipelineIds, and mainVideoId required')
  }
  const { executeCreateStrategy, executeCreateCombinedStrategy, brollPipelineProgress, loadExampleVideos } =
    await import('./broll.js')

  // Skip analyses that already have a completed strategy (column-based dedup).
  const createStrategy = await db.prepare(
    "SELECT id FROM broll_strategies WHERE strategy_kind = 'create_strategy' ORDER BY id LIMIT 1"
  ).get()
  const existingStratRuns = createStrategy
    ? await db.prepare(
        `SELECT metadata_json FROM broll_runs
         WHERE video_id = ? AND strategy_id = ? AND status = 'complete'
           AND metadata_json NOT LIKE '%"isSubRun":true%'`
      ).all(mainVideoId, createStrategy.id)
    : []
  const alreadyDoneAnalysisIds = new Set()
  for (const r of existingStratRuns) {
    try {
      const m = JSON.parse(r.metadata_json || '{}')
      if (m.analysisPipelineId) alreadyDoneAnalysisIds.add(m.analysisPipelineId)
    } catch {}
  }

  const newAnalysisIds = analysisPipelineIds.filter(id => !alreadyDoneAnalysisIds.has(id))
  const skippedCount = analysisPipelineIds.length - newAnalysisIds.length
  if (skippedCount) console.log(`[broll-runner] Skipping ${skippedCount} strategies (already exist)`)

  // ── Order analysis IDs: favorite first, then variants in example order ──
  // Map each analysis pipeline ID to its reference video via the -ex<videoId>
  // suffix already encoded in the ID (see runAllReferences pid construction).
  const exampleVideos = subGroupId ? await loadExampleVideos(subGroupId) : []
  const favoriteVideoId = (exampleVideos.find(v => v.isFavorite) || exampleVideos[0])?.id ?? null

  function videoIdFromAnalysisId(analysisId) {
    const m = String(analysisId).match(/-ex(\d+)$/)
    if (!m) throw new Error(`[broll-chain] cannot extract videoId from analysisPipelineId: ${analysisId}`)
    return Number(m[1])
  }

  const orderedAnalysisIds = [...newAnalysisIds].sort((a, b) => {
    const va = videoIdFromAnalysisId(a)
    const vb = videoIdFromAnalysisId(b)
    if (va === favoriteVideoId && vb !== favoriteVideoId) return -1
    if (vb === favoriteVideoId && va !== favoriteVideoId) return 1
    // Preserve example-order for non-favorites (loadExampleVideos returns insertion order)
    const ia = exampleVideos.findIndex(v => v.id === va)
    const ib = exampleVideos.findIndex(v => v.id === vb)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })

  // ── Reserve all strategy pipeline IDs upfront ──
  const allPipelineIds = []
  const variantPlan = []  // [{ analysisPipelineId, pid }] in execution order, excluding favorite
  let favoritePid = null
  const baseTs = Date.now()
  for (let idx = 0; idx < orderedAnalysisIds.length; idx++) {
    const analysisPipelineId = orderedAnalysisIds[idx]
    const pid = `strat-${mainVideoId}-${baseTs + idx}-${analysisPipelineId.slice(-6)}`
    allPipelineIds.push(pid)
    brollPipelineProgress.set(pid, {
      videoId: mainVideoId, groupId: subGroupId, status: 'running',
      stageName: idx === 0 ? 'Loading data...' : 'Waiting for favorite...',
      stageIndex: 0, totalStages: 1, phase: 'create_strategy',
    })
    if (idx === 0) {
      favoritePid = pid
    } else {
      variantPlan.push({ analysisPipelineId, pid })
    }
  }

  // ── Combined strategy (independent, parallel, unchanged from before) ──
  let combinedPipelineId = null
  const combinedStrategy = await db.prepare(
    "SELECT id FROM broll_strategies WHERE strategy_kind = 'create_combined_strategy' ORDER BY id LIMIT 1"
  ).get()
  const existingCombined = combinedStrategy
    ? !!(await db.prepare(
        `SELECT 1 FROM broll_runs
         WHERE video_id = ? AND strategy_id = ? AND status = 'complete'
           AND metadata_json NOT LIKE '%"isSubRun":true%'
         LIMIT 1`
      ).get(mainVideoId, combinedStrategy.id))
    : false
  const shouldFireCombined = analysisPipelineIds.length >= 2 && (!existingCombined || newAnalysisIds.length > 0)
  if (shouldFireCombined) {
    combinedPipelineId = `cstrat-${mainVideoId}-${baseTs}`
    allPipelineIds.push(combinedPipelineId)
    brollPipelineProgress.set(combinedPipelineId, {
      videoId: mainVideoId, groupId: subGroupId, status: 'running',
      stageName: 'Loading data...', stageIndex: 0, totalStages: 1, phase: 'create_combined_strategy',
    })
  }

  console.log(`[broll-chain] favorite=${favoritePid} variants=[${variantPlan.map(v => v.pid).join(', ')}] combined=${combinedPipelineId || 'none'}`)

  // ── Fire favorite + combined immediately, parallel ──
  if (favoritePid) {
    executeCreateStrategy(prepPipelineId, orderedAnalysisIds[0], mainVideoId, subGroupId || null, favoritePid, [])
      .catch(err => {
        console.error(`[broll-runner] Favorite strategy failed: ${err.message}`)
        const p = brollPipelineProgress.get(favoritePid)
        if (p) brollPipelineProgress.set(favoritePid, { ...p, status: 'failed', error: err.message })
      })
  }
  if (shouldFireCombined) {
    executeCreateCombinedStrategy(prepPipelineId, analysisPipelineIds, mainVideoId, subGroupId || null, combinedPipelineId)
      .catch(err => console.error(`[broll-runner] Combined strategy failed: ${err.message}`))
  }

  // ── Spawn fire-and-forget chain for variants ──
  if (variantPlan.length > 0 && favoritePid) {
    ;(async () => {
      await waitForPipelinesComplete([favoritePid])
      console.log(`[broll-chain] favorite ${favoritePid} complete; starting variant chain`)
      const completed = [favoritePid]
      for (const v of variantPlan) {
        const priors = completed.slice()
        console.log(`[broll-chain] firing variant ${v.pid} priors=[${priors.join(',')}] (n=${priors.length})`)
        const p = brollPipelineProgress.get(v.pid)
        if (p) brollPipelineProgress.set(v.pid, { ...p, stageName: 'Loading data...' })
        await executeCreateStrategy(
          prepPipelineId, v.analysisPipelineId,
          mainVideoId, subGroupId || null,
          v.pid, priors,
        )
        completed.push(v.pid)
        console.log(`[broll-chain] variant ${v.pid} complete`)
      }
    })().catch(err => {
      console.error(`[broll-chain] chain failed: ${err.message}`)
      for (const v of variantPlan) {
        const p = brollPipelineProgress.get(v.pid)
        if (p && p.status === 'running') {
          brollPipelineProgress.set(v.pid, { ...p, status: 'failed', error: `chain aborted: ${err.message}` })
        }
      }
    })
  }

  console.log(`[broll-runner] runStrategies: reserved ${allPipelineIds.length} pipelines (1 favorite + ${variantPlan.length} variants + ${shouldFireCombined ? 1 : 0} combined)`)

  return { strategyPipelineIds: allPipelineIds, combinedPipelineId }
}
```

- [ ] **Step 5.3: Confirm `loadExampleVideos` is exported from broll.js**

```bash
grep -n "^export.*loadExampleVideos" server/services/broll.js
```
Expected: `1004:export async function loadExampleVideos(groupId) {`

If the function exists but isn't exported, add `export` before it. (Per current grep, it should already be exported.)

- [ ] **Step 5.4: Run full vitest to confirm nothing broke**

```bash
npx vitest --run --reporter=basic 2>&1 | tail -8
```
Expected: same 10 pre-existing failures, 18 prior-strategies tests pass, total passing = 323. No new failures.

- [ ] **Step 5.5: Commit**

```bash
git add server/services/broll-runner.js
git commit -m "$(cat <<'EOF'
feat(broll): runStrategies fires favorite + combined immediately, chains variants

Per-reference variants now run sequentially after the Favorite reference's
strategy completes, each receiving prior strategies as priorStrategyPipelineIds.
Favorite + Combined still fire immediately in parallel. All pipeline IDs are
reserved upfront so the caller's waitForPipelinesComplete works unchanged.
Chain failure flips remaining variants to 'failed' in brollPipelineProgress.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Update create_strategy seed to inject directive at top of Step 5

**Files:**
- Modify: `server/seed/update-create-strategy-beat-first.js`

- [ ] **Step 6.1: Read the current seed prompt to identify the Step 5 anchor**

```bash
grep -n "Step 5: Build per-beat strategies" server/seed/update-create-strategy-beat-first.js
```
Expected: `64:## Step 5: Build per-beat strategies (CRITICAL)`

- [ ] **Step 6.2: Edit the seed prompt — insert directive after the Step 5 heading**

Use the Edit tool. Find this exact block in `server/seed/update-create-strategy-beat-first.js`:

```javascript
## Step 5: Build per-beat strategies (CRITICAL)

This is the most important part. For each beat in THIS chapter:
```

Replace with:

```javascript
## Step 5: Build per-beat strategies (CRITICAL)

{{prior_chapter_strategies}}

If prior strategies for this chapter are shown above, your strategy MUST be meaningfully different. Do not produce the same or a similar approach. Choose different visual angles, different beat strategies, different style/motion choices. The goal is genuine variety across reference videos — not minor re-wordings.

This is the most important part. For each beat in THIS chapter:
```

(The rest of Step 5 — the numbered list of beat-building rules — stays unchanged.)

- [ ] **Step 6.3: Verify the edit by re-reading**

```bash
grep -A 5 "Step 5: Build per-beat strategies" server/seed/update-create-strategy-beat-first.js | head -10
```
Expected: shows `{{prior_chapter_strategies}}` and the directive paragraph.

- [ ] **Step 6.4: Confirm idempotency by inspecting that the seed only updates one anchored block**

```bash
grep -c "prior_chapter_strategies" server/seed/update-create-strategy-beat-first.js
```
Expected: `1` (single occurrence — re-running the seed sets the prompt to this same content via UPDATE, no double-insertion).

- [ ] **Step 6.5: Run vitest to confirm nothing broke**

```bash
npx vitest --run --reporter=basic 2>&1 | tail -5
```
Expected: same baseline failures unchanged.

- [ ] **Step 6.6: Commit**

```bash
git add server/seed/update-create-strategy-beat-first.js
git commit -m "$(cat <<'EOF'
feat(broll): seed create_strategy Step 5 with prior-strategies directive

Adds {{prior_chapter_strategies}} placeholder + 'do not produce a similar
strategy' directive at the top of Step 5 in the per-chapter strategy prompt.
Resolves to empty for the favorite (no priors); for variants the runtime
substitutes the chain-formatted slim block ahead of the LLM call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual verification (post-implementation)

**Files:** none (verification only — no code change, no commit)

This task is documentation; do not skip it. Do NOT mark Task 6 as the final completion until these checks pass.

- [ ] **Step 7.1: Apply the seed update against your local DB**

```bash
node server/seed/update-create-strategy-beat-first.js
```
Expected: `Done — create_strategy (id=...) updated:` and the new directive text appears in `stages_json`. Re-run once to confirm idempotency (no error, no duplication).

- [ ] **Step 7.2: Verify the live strategy version contains the new directive**

```bash
node -e "
import('./server/db.js').then(async ({default: db}) => {
  const s = await db.prepare(\"SELECT id FROM broll_strategies WHERE strategy_kind='create_strategy' ORDER BY id LIMIT 1\").get()
  const v = await db.prepare('SELECT stages_json FROM broll_strategy_versions WHERE strategy_id=? ORDER BY created_at DESC LIMIT 1').get(s.id)
  const stages = JSON.parse(v.stages_json)
  const perCh = stages.find(st => st.per_chapter)
  console.log('Has placeholder:', perCh.prompt.includes('{{prior_chapter_strategies}}'))
  console.log('Has directive:', perCh.prompt.includes('do NOT produce') || perCh.prompt.includes('do not produce'))
  process.exit(0)
})
"
```
Expected: both lines print `true`.

- [ ] **Step 7.3: 2-reference smoke test**

In the running app (NOT via `npm run dev:server` per project memory), use a video group with 2 references. Star one as Favorite. Trigger the b-roll pipeline. Confirm via server logs:

```
[broll-chain] favorite=strat-XXX variants=[strat-YYY] combined=cstrat-ZZZ
[broll-chain] executeCreateStrategy strat-XXX priors=[]
[broll-chain] favorite strat-XXX complete; starting variant chain
[broll-chain] firing variant strat-YYY priors=[strat-XXX] (n=1)
[broll-chain] executeCreateStrategy strat-YYY priors=[strat-XXX]
[broll-chain] variant strat-YYY chapter 0 injecting priors n=1 bytes=<>0
```

- [ ] **Step 7.4: DB inspection — verify directive landed in variant's prompt**

```bash
node -e "
import('./server/db.js').then(async ({default: db}) => {
  const r = await db.prepare(\`
    SELECT prompt_used, system_instruction_used FROM broll_runs
    WHERE metadata_json LIKE '%\"phase\":\"create_strategy\"%'
      AND metadata_json LIKE '%\"isSubRun\":true%'
      AND metadata_json LIKE '%\"subIndex\":0%'
    ORDER BY id DESC LIMIT 5
  \`).all()
  for (const row of r) {
    console.log('---')
    console.log('Has placeholder:', /\\{\\{prior_chapter_strategies\\}\\}/.test(row.prompt_used))
    console.log('Has directive:', /do NOT produce a similar strategy/.test(row.prompt_used))
    console.log('Has slim block:', /=== Source:/.test(row.prompt_used))
  }
  process.exit(0)
})
"
```
Expected:
- Favorite's row: `placeholder: false` (substituted to empty), `directive: false` (no priors text), `slim block: false`
- Variant's row: `placeholder: false` (substituted), `directive: true`, `slim block: true`

- [ ] **Step 7.5: 3-reference smoke (optional but recommended)**

Repeat with 3 references. Verify Variant C's prompt contains BOTH Favorite's and Variant B's slim blocks (search `=== Source:` should appear twice).

- [ ] **Step 7.6: Confirm no regression in existing 1-reference flow**

Run pipeline on a group with only 1 reference (no Variants). Confirm logs show favorite fires immediately, no chain spawned, no errors.

---

## Out of Scope

- CombinedStrategy seed unchanged
- create_plan seed unchanged
- No retry/backoff for chain failures
- No UI changes
- Live production strategy id=9 update — re-run the seed against prod DB at deploy time, or patch via admin UI manually
