# Export Manifest Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the export manifest endpoint so projects whose b-roll results live in legacy storage (`broll_runs` / `broll_search_logs`) export correctly, AND exclude Storyblocks from exports while keeping Envato/Pexels/Freepik supported.

**Architecture:** The manifest endpoint currently queries only `broll_searches` directly. The b-roll editor uses `getBRollEditorData()` which has 3-tier fallback (queue → `broll_runs` → `broll_search_logs`). We'll refactor the manifest endpoint to call `getBRollEditorData()` so both UIs see the same data, then transform placements into manifest items with a Storyblocks filter.

**Tech Stack:** Node.js, Express, better-sqlite3 / pg, vitest 1.6.x, ES modules.

---

## Files affected

- **Modify:** `server/routes/broll.js` — replace the SQL block in the manifest handler at lines 111-209 with a call to `getBRollEditorData()` plus a transform step.
- **Create:** `server/routes/__tests__/broll-export-manifest.test.js` — unit tests for the new manifest builder, mocked DB.
- **Modify:** `server/services/broll.js` — extract the placement→manifest-item transform into an exported pure function so it's directly testable.

## Background reading

Before implementing, read these so you don't reinvent:
- `server/routes/broll.js:96-209` — current manifest endpoint
- `server/services/broll.js:4916-5210` — `getBRollEditorData()` and its return shape
- `server/routes/__tests__/broll-path-flags.test.js` — mock pattern for the `db.js` import
- `docs/specs/2026-04-23-envato-export-design.md` § "Manifest shape (unified)" — output contract
- `docs/superpowers/plans/2026-04-24-webapp-xmeml-generator.md` § "Manifest item fields" — every field consumers depend on

## Output contract (manifest item shape — unchanged)

```js
{
  seq: 1,                                          // 1-based position in the manifest
  timeline_start_s: 12.5,                          // user-edited if present, else placement.start
  timeline_duration_s: 4.0,                        // (end - start)
  source: 'envato' | 'pexels' | 'freepik',         // NEVER 'storyblocks' (filtered)
  source_item_id: 'NX9WYGQ',
  envato_item_url: 'https://elements.envato.com/...' | null,  // null for non-envato
  target_filename: '001_envato_NX9WYGQ.mov',
  resolution: { width: 1920, height: 1080 },
  frame_rate: 30,
  est_size_bytes: 150000000,
  variant_label: 'A' | null,
}
```

## Selection rule

For each placement with `results.length > 0`:
1. **If** `placement.persistedSelectedResult` is a non-null object → use it (user picked this clip in the editor)
2. **Else** → use `placement.results[0]` (top-ranked candidate)
3. **Then** if `pick.source.toLowerCase() === 'storyblocks'` → skip the placement entirely (Storyblocks not supported by the export pipeline)
4. **Then** if `!pick.source_item_id` → skip (malformed result)

## Variant filter behavior

The endpoint accepts optional `?variant=<label>`. After this refactor:
- `getBRollEditorData()` returns placements without a `variant_label` field (legacy data is per-pipelineId, queue data has the label).
- For the queue path, each placement DOES carry `variant_label` from the DB row — propagate it through.
- If `?variant=` is provided, **filter post-transform** to items whose `variant_label === variant` (case-insensitive, also accept the "Variant X" / "X" form like the existing code).
- If no items have `variant_label` populated (legacy-only data), the filter behaves as a no-op pass-through and returns everything (because legacy data has no variant info — nothing to filter on, return all).

## File Structure decisions

- `buildManifestFromPlacements(placements, { variant })` lives in `server/services/broll.js` next to `getBRollEditorData`. Pure function. No DB access. Easy to unit-test.
- The route handler stays in `server/routes/broll.js` and becomes thin: read params → call `getBRollEditorData` → call `buildManifestFromPlacements` → return JSON.

---

## Task 1: Extract `buildManifestFromPlacements` as a pure function

**Files:**
- Create: `server/routes/__tests__/broll-export-manifest.test.js` (new)
- Modify: `server/services/broll.js` — append `buildManifestFromPlacements` export near `getBRollEditorData` (after line 5210)

- [ ] **Step 1: Write the failing test**

Create `server/routes/__tests__/broll-export-manifest.test.js` with this exact content:

```javascript
// server/routes/__tests__/broll-export-manifest.test.js
//
// Unit tests for buildManifestFromPlacements — the pure transform that
// turns getBRollEditorData()'s placements into the export-manifest
// shape. Mocks db.js because importing broll.js triggers a top-level
// db import whose side effects exit on missing DATABASE_URL.

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    prepare() {
      return {
        async all() { return [] },
        async get() { return null },
        async run() { return { lastInsertRowid: 0 } },
      }
    },
  },
}))

import { buildManifestFromPlacements } from '../../services/broll.js'

function makePlacement(overrides = {}) {
  return {
    chapterIndex: 0,
    placementIndex: 0,
    start: 10,
    end: 14,
    description: 'sunset',
    results: [],
    searchStatus: 'complete',
    ...overrides,
  }
}

function makeResult(overrides = {}) {
  return {
    source: 'envato',
    source_item_id: 'NX9WYGQ',
    envato_item_url: 'https://elements.envato.com/stock-video/foo-NX9WYGQ',
    resolution: { width: 1920, height: 1080 },
    frame_rate: 30,
    duration_seconds: 4,
    est_size_bytes: 150000000,
    rank_score: 0.9,
    rank_method: 'siglip+qwen',
    ...overrides,
  }
}

describe('buildManifestFromPlacements', () => {
  it('returns empty manifest when no placements have results', () => {
    const placements = [makePlacement({ results: [] })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toEqual([])
    expect(out.totals).toEqual({ count: 0, est_size_bytes: 0, by_source: {} })
  })

  it('emits manifest item from results[0] when no user pick', () => {
    const placements = [makePlacement({ results: [makeResult()] })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source).toBe('envato')
    expect(out.items[0].source_item_id).toBe('NX9WYGQ')
    expect(out.items[0].envato_item_url).toBe('https://elements.envato.com/stock-video/foo-NX9WYGQ')
    expect(out.items[0].seq).toBe(1)
    expect(out.items[0].timeline_start_s).toBe(10)
    expect(out.items[0].timeline_duration_s).toBe(4)
  })

  it('prefers persistedSelectedResult over results[0]', () => {
    const top = makeResult({ source_item_id: 'TOP_ID' })
    const picked = makeResult({ source: 'pexels', source_item_id: '12345' })
    const placements = [makePlacement({ results: [top], persistedSelectedResult: picked })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].source).toBe('pexels')
    expect(out.items[0].source_item_id).toBe('12345')
  })

  it('filters out storyblocks results entirely', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'storyblocks', source_item_id: 'sb_1' })] }),
      makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: 'px_1' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source).toBe('pexels')
    expect(out.totals.by_source).toEqual({ pexels: 1 })
  })

  it('filters storyblocks case-insensitively (StoryBlocks, STORYBLOCKS)', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'StoryBlocks' })] }),
      makePlacement({ results: [makeResult({ source: 'STORYBLOCKS' })] }),
      makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: 'p1' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source).toBe('pexels')
  })

  it('emits target_filename with seq prefix + source + safe id', () => {
    const placements = [makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: '12345/extra' })] })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].target_filename).toBe('001_pexels_12345_extra.mp4')
  })

  it('uses .mov for envato, .mp4 for pexels and freepik', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'envato', source_item_id: 'e1' })] }),
      makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: 'p1' })] }),
      makePlacement({ results: [makeResult({ source: 'freepik', source_item_id: 'f1' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].target_filename).toMatch(/\.mov$/)
    expect(out.items[1].target_filename).toMatch(/\.mp4$/)
    expect(out.items[2].target_filename).toMatch(/\.mp4$/)
  })

  it('skips placements where pick has no source_item_id', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source_item_id: null })] }),
      makePlacement({ results: [makeResult({ source_item_id: '' })] }),
      makePlacement({ results: [makeResult({ source_item_id: 'ok' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source_item_id).toBe('ok')
  })

  it('uses userTimelineStart/userTimelineEnd when present (editor user-edit override)', () => {
    const placements = [makePlacement({
      start: 10, end: 14,
      userTimelineStart: 25, userTimelineEnd: 27,
      results: [makeResult()],
    })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items[0].timeline_start_s).toBe(25)
    expect(out.items[0].timeline_duration_s).toBe(2)
  })

  it('falls back to estimated size when est_size_bytes missing', () => {
    const placements = [makePlacement({
      results: [makeResult({ est_size_bytes: undefined, duration_seconds: 4 })],
    })]
    const out = buildManifestFromPlacements(placements, { variant: null })
    // 4 * 25 * 1024 * 1024 = 104857600
    expect(out.items[0].est_size_bytes).toBe(104857600)
  })

  it('totals aggregates count, bytes, and by_source', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'envato',  source_item_id: 'e1', est_size_bytes: 100 })] }),
      makePlacement({ results: [makeResult({ source: 'pexels',  source_item_id: 'p1', est_size_bytes: 200 })] }),
      makePlacement({ results: [makeResult({ source: 'freepik', source_item_id: 'f1', est_size_bytes: 300 })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.totals).toEqual({ count: 3, est_size_bytes: 600, by_source: { envato: 1, pexels: 1, freepik: 1 } })
  })

  it('filters by variant when variant_label present (queue data path)', () => {
    const placements = [
      makePlacement({ variant_label: 'A', results: [makeResult({ source_item_id: 'a1' })] }),
      makePlacement({ variant_label: 'B', results: [makeResult({ source_item_id: 'b1' })] }),
      makePlacement({ variant_label: 'A', results: [makeResult({ source_item_id: 'a2' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: 'A' })
    expect(out.items).toHaveLength(2)
    expect(out.items.map(i => i.source_item_id)).toEqual(['a1', 'a2'])
  })

  it('treats "Variant A" and "A" as equivalent for variant filter', () => {
    const placements = [
      makePlacement({ variant_label: 'Variant A', results: [makeResult({ source_item_id: 'a1' })] }),
      makePlacement({ variant_label: 'A',         results: [makeResult({ source_item_id: 'a2' })] }),
      makePlacement({ variant_label: 'B',         results: [makeResult({ source_item_id: 'b1' })] }),
    ]
    const out1 = buildManifestFromPlacements(placements, { variant: 'A' })
    const out2 = buildManifestFromPlacements(placements, { variant: 'Variant A' })
    expect(out1.items.map(i => i.source_item_id).sort()).toEqual(['a1', 'a2'])
    expect(out2.items.map(i => i.source_item_id).sort()).toEqual(['a1', 'a2'])
  })

  it('returns all items when variant requested but no placements have variant_label (legacy data)', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source_item_id: 'x1' })] }),
      makePlacement({ results: [makeResult({ source: 'pexels', source_item_id: 'x2' })] }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: 'A' })
    // Legacy data has no variant_label — pass through rather than filter to zero.
    expect(out.items).toHaveLength(2)
  })

  it('skips placements marked hidden via editor edits', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source_item_id: 'keep' })] }),
      makePlacement({ results: [makeResult({ source_item_id: 'drop' })], hidden: true }),
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items).toHaveLength(1)
    expect(out.items[0].source_item_id).toBe('keep')
  })

  it('seq is 1-based and gap-free across kept placements', () => {
    const placements = [
      makePlacement({ results: [makeResult({ source: 'storyblocks', source_item_id: 's1' })] }),  // skipped
      makePlacement({ results: [makeResult({ source: 'pexels',      source_item_id: 'p1' })] }),  // seq 1
      makePlacement({ results: [] }),                                                              // skipped
      makePlacement({ results: [makeResult({ source: 'envato',      source_item_id: 'e1' })] }),  // seq 2
    ]
    const out = buildManifestFromPlacements(placements, { variant: null })
    expect(out.items.map(i => i.seq)).toEqual([1, 2])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/routes/__tests__/broll-export-manifest.test.js`
Expected: FAIL — `Cannot find export 'buildManifestFromPlacements' from '../../services/broll.js'` (or similar import error). All 16 tests in red.

- [ ] **Step 3: Implement `buildManifestFromPlacements` in `server/services/broll.js`**

Append this export to `server/services/broll.js` (after the `getBRollEditorData` function ends, near line 5210):

```javascript
// Pure transform: getBRollEditorData() placements → export manifest items.
// Filters Storyblocks (export pipeline non-goal). Picks the user-selected
// result if present, else the top-ranked candidate. Variant filter is
// applied case-insensitively against `variant_label` and is forgiving of
// the "Variant X" vs "X" mismatch. When NO placement has variant_label
// (legacy data), the filter is a no-op pass-through (legacy data is
// per-pipelineId, not per-variant — there's no label to filter on).
//
// This function is exported separately from getBRollEditorData so the
// route handler can stay thin and the transform is unit-testable
// without a DB.
export function buildManifestFromPlacements(placements, { variant } = {}) {
  // Variant normalization: accept "A" or "Variant A".
  const variantNorm = variant
    ? variant.trim().replace(/^Variant\s+/i, '').toLowerCase()
    : null

  // Pre-pass: detect whether ANY placement carries a variant_label.
  // If none do, the variant filter is a no-op (legacy data path).
  const anyHasLabel = placements.some(p => p.variant_label != null && p.variant_label !== '')
  const applyVariantFilter = !!(variantNorm && anyHasLabel)

  let seq = 0
  const items = []
  let estTotal = 0
  const bySource = {}

  for (const p of placements) {
    if (p.hidden) continue
    if (!Array.isArray(p.results) || p.results.length === 0) continue

    // Variant filter (queue data path).
    if (applyVariantFilter) {
      const label = String(p.variant_label || '')
        .trim()
        .replace(/^Variant\s+/i, '')
        .toLowerCase()
      if (label !== variantNorm) continue
    }

    // Selection rule: user pick > top-ranked.
    const pick = (p.persistedSelectedResult && typeof p.persistedSelectedResult === 'object')
      ? p.persistedSelectedResult
      : p.results[0]
    if (!pick) continue

    const source = String(pick.source || '').toLowerCase()
    if (!source) continue
    if (source === 'storyblocks') continue   // Export-pipeline non-goal.

    const sourceItemId = pick.source_item_id || pick.id || pick.uid || null
    if (!sourceItemId) continue

    seq += 1
    const ext = source === 'envato' ? 'mov' : 'mp4'
    const safeId = String(sourceItemId).replace(/[^A-Za-z0-9_-]/g, '_')
    const targetFilename = `${String(seq).padStart(3, '0')}_${source}_${safeId}.${ext}`

    // Timeline: prefer user-edited positions over plan defaults.
    const startS = (p.userTimelineStart != null) ? p.userTimelineStart : (p.start ?? null)
    const endS   = (p.userTimelineEnd   != null) ? p.userTimelineEnd   : (p.end   ?? null)
    const durS   = (startS != null && endS != null) ? Math.max(0, endS - startS) : null

    const item = {
      seq,
      timeline_start_s: startS,
      timeline_duration_s: durS,
      source,
      source_item_id: String(sourceItemId),
      envato_item_url: source === 'envato' ? (pick.envato_item_url || null) : null,
      target_filename: targetFilename,
      resolution: pick.resolution || { width: pick.width || 1920, height: pick.height || 1080 },
      frame_rate: pick.frame_rate || 30,
      est_size_bytes: typeof pick.est_size_bytes === 'number'
        ? pick.est_size_bytes
        : (pick.duration_seconds ? Math.round(pick.duration_seconds * 25 * 1024 * 1024) : 100 * 1024 * 1024),
      variant_label: p.variant_label || null,
    }
    items.push(item)
    estTotal += item.est_size_bytes
    bySource[source] = (bySource[source] || 0) + 1
  }

  return {
    items,
    totals: { count: items.length, est_size_bytes: estTotal, by_source: bySource },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/routes/__tests__/broll-export-manifest.test.js`
Expected: PASS — all 16 tests green.

- [ ] **Step 5: Commit**

```bash
git add server/services/broll.js server/routes/__tests__/broll-export-manifest.test.js
git commit -m "feat(export): extract buildManifestFromPlacements pure transform

Storyblocks now filtered out (export-pipeline non-goal per spec).
User pick (persistedSelectedResult) takes precedence over top-ranked.
User-edited timeline positions (userTimelineStart/End) override defaults.
Variant filter is case-insensitive, accepts 'A' or 'Variant A', and
no-ops when placements lack variant_label (legacy data path).

16 unit tests, mocked DB, no integration coupling."
```

---

## Task 2: Wire the manifest endpoint to use `getBRollEditorData` + `buildManifestFromPlacements`

**Files:**
- Modify: `server/routes/broll.js:111-209` — replace SQL block with helper call.

- [ ] **Step 1: Verify Task 1 is committed**

Run: `git log --oneline -1`
Expected: latest commit is the buildManifestFromPlacements commit.

- [ ] **Step 2: Read the current handler one more time**

Read `server/routes/broll.js:96-209`. Confirm what's there matches what the diff in Step 3 expects.

- [ ] **Step 3: Replace the handler body**

In `server/routes/broll.js`, find the import line near the top:

```javascript
import { getBRollEditorData, /* maybe other things */ } from '../services/broll.js'
```

If `getBRollEditorData` isn't already imported, add it. Also import `buildManifestFromPlacements`:

```javascript
import { getBRollEditorData, buildManifestFromPlacements } from '../services/broll.js'
```

(If the existing import already has `getBRollEditorData`, just append `, buildManifestFromPlacements`.)

Then find the handler at line 111:

```javascript
brollSearchesRouter.get('/:pipelineId/manifest', requireAuth, async (req, res) => {
  try {
    const pipelineId = String(req.params.pipelineId || '')
    if (!pipelineId) return res.status(400).json({ error: 'pipelineId required' })
    const variant = req.query.variant ? String(req.query.variant) : null

    // ... ALL the variantAlt / SQL / row loop / item building logic ...

    res.json({
      pipeline_id: pipelineId,
      variant,
      items,
      totals: { count: items.length, est_size_bytes: estTotal, by_source: bySource },
    })
  } catch (err) {
    console.error('[broll-export-manifest] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
```

Replace its body so the whole handler becomes:

```javascript
brollSearchesRouter.get('/:pipelineId/manifest', requireAuth, async (req, res) => {
  try {
    const pipelineId = String(req.params.pipelineId || '')
    if (!pipelineId) return res.status(400).json({ error: 'pipelineId required' })
    const variant = req.query.variant ? String(req.query.variant) : null

    // Use the same data path as the b-roll editor — 3-tier fallback
    // (broll_searches → broll_runs → broll_search_logs) plus user
    // edits from broll_editor_state. Without this, projects whose
    // searches landed in legacy storage show 0 items in the export
    // pre-flight even though the editor displays them correctly.
    const editorData = await getBRollEditorData(pipelineId)
    const placements = Array.isArray(editorData?.placements) ? editorData.placements : []

    // Pure transform: pick → filter → manifest item shape.
    const { items, totals } = buildManifestFromPlacements(placements, { variant })

    res.json({ pipeline_id: pipelineId, variant, items, totals })
  } catch (err) {
    console.error('[broll-export-manifest] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 4: Run the full server test suite**

Run: `npx vitest run --project=server`
Expected: PASS — all server tests green, including the new broll-export-manifest test from Task 1, and the existing exports/support-bundles/etc. suites untouched.

- [ ] **Step 5: Run the full vitest workspace**

Run: `npx vitest run`
Expected: PASS — workspace total (server + extension + web) green. Note: count must match (or exceed by 16) the pre-Task-1 baseline.

- [ ] **Step 6: Smoke the endpoint locally if backend is running**

Skip this step if you don't have a running backend. Otherwise:
```bash
curl -s "http://localhost:3001/api/broll-searches/<pipelineId-with-known-clips>/manifest" \
  -H "Authorization: Bearer $LOCAL_TEST_JWT" | jq '.totals'
```
Expected: `{count: <N>, est_size_bytes: <bytes>, by_source: {...}}` with at least one source. Storyblocks should NOT appear in `by_source`.

- [ ] **Step 7: Commit**

```bash
git add server/routes/broll.js
git commit -m "fix(export): manifest uses getBRollEditorData + storyblocks filter

The manifest endpoint was querying broll_searches directly, missing
the 3-tier fallback (broll_runs / broll_search_logs) that the editor
uses. Projects with legacy-only data showed 0 export items even
though the editor displayed clips correctly.

Now delegates to getBRollEditorData() (same data path as the editor)
and buildManifestFromPlacements() (pure transform, storyblocks filter,
variant resolution, user-pick precedence). Route handler is now a
thin adapter — all logic is unit-tested in Task 1."
```

---

## Self-review

**1. Spec coverage:**
- ✅ Refactor manifest to use editor data path → Task 2
- ✅ Filter out Storyblocks → Task 1 selection rule + 2 dedicated tests
- ✅ Keep Pexels/Envato/Freepik supported → tests in Task 1
- ✅ User-pick precedence → Task 1 + dedicated test
- ✅ Variant filter (case-insensitive, "A" / "Variant A" forms, legacy no-op) → Task 1 + 3 dedicated tests
- ✅ Hidden-placement skip → Task 1 + dedicated test
- ✅ User-edited timeline positions → Task 1 + dedicated test

**2. Placeholder scan:**
- No "TBD" / "later" / "similar to" entries.
- All test code is complete and runnable.
- All implementation code is complete.

**3. Type consistency:**
- `buildManifestFromPlacements(placements, { variant })` — same signature in tests and impl.
- Return shape `{ items, totals: { count, est_size_bytes, by_source } }` — matches tests, impl, and route.

**4. Out-of-scope (deliberately deferred):**
- Updating the Export button in `EditorView.jsx` to pass the active variant's child pipelineId. The button currently passes the URL's `:id` (parent group). For projects where variants are sub-pipelines, this means `?variant=A` may not match anything in the queue path — but the new fallback to `getBRollEditorData()` returns ALL placements (legacy data is per-pipelineId), and the legacy no-op variant filter passes them through. So the user gets clips. We can lift `activePipelineId` into `EditorContext` in a follow-up plan if needed.
- XMEML emission of variant-specific multi-track output. The XMEML generator already runs after this; nothing in this plan touches it.
- A "list available variants" endpoint for the export page UI. Could be a follow-up if the user wants a dropdown rather than a URL-edit workflow.

---
