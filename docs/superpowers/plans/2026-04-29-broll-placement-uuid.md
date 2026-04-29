# B-Roll Placement UUID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind `broll_searches` rows (and editor state) to a stable per-placement UUID instead of the positional `(chapter_index, placement_index)` tuple, so reordering / re-running / future placement-edit features cannot silently misalign search results with placements.

**Architecture:** Each chapter-derived placement gets a UUID (`p_<12 chars>`) the first time it is observed. UUIDs live in a new side table `broll_placement_uuids(plan_pipeline_id, chapter_index, placement_index, uuid)` — the LLM's `broll_runs.output_text` is **never mutated**. All search paths key off `placement_uuid`; the legacy `(chapter_index, placement_index)` columns stay in `broll_searches` for debug/legacy fallback. User placements (`userPlacementId`) are unchanged; their `userPlacementId` is also exposed under the unified `uuid` field. Cross-variant `selectIdentity` is left positional — that's a different problem (different plan = different placements = different UUIDs).

**Caveat with the side-table approach:** Because the side table is keyed by `(plan_pipeline_id, chapter_index, placement_index)`, a future "reorder placements within a chapter" feature would need to explicitly update the side table to keep UUIDs travelling with their placements. Today there is no such UI, so this is a clean MVP. Documented in the Risks section.

**Tech Stack:** Postgres (Supabase), Node.js (Express), React (Vite), Vitest.

**Out of scope:** Changing how variants match each other across plans (selectIdentity); per-result UUIDs inside `results_json`; reorder/move UI for placements. This plan only stabilizes the placement→search-row binding.

---

## File Structure

- **Modify:** `server/schema-pg.sql` (around line 112-131) — add `placement_uuid TEXT` to `broll_searches`; create new `broll_placement_uuids` table.
- **Modify:** `server/db.js` (migrations block, around line 46-173) — `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS` + idempotent backfill.
- **Create:** `server/services/broll-placement-uuid.js` — helper module: `getOrCreatePlacementUuid(planPipelineId, chapterIndex, placementIndex)`, `ensurePlanUuids(planPipelineId)` returning `Map<chapterIndex, Map<placementIndex, uuid>>`. All operations hit the side table — `broll_runs.output_text` is read-only.
- **Modify:** `server/services/broll.js`:
  - Line 5101-5137 (placement materialization in `getBRollEditorData`) — look up `uuid` per placement.
  - Line 5141-5192 (broll_searches → placement match) — match by `placement_uuid`, fallback to indices.
  - Line 2283-2326 (`_getPendingGpuPlacements`) — return `uuid` per pending item, key exclusion set by uuid.
  - Line 2220-2280 (`_buildSearchParams`) — accept `uuid` (kw-lookup stays positional internally).
  - Line 2122-2135 (broll_searches INSERT) — write `placement_uuid`.
- **Modify:** `server/routes/broll.js`:
  - Line 1015-1031 (`POST /pipeline/:pipelineId/search-placement`) — accept `placementUuid`; resolve to `(chapterIndex, placementIndex)` for kw lookup.
  - Line 145-162 (manifest endpoint) — key by `placementUuid`.
- **Modify:** `src/components/editor/useBRollEditorState.js`:
  - Line 397, 421 (`searchPlacement`, `searchPlacementCustom`) — pass `uuid` instead of indices.
  - Migration of `broll_editor_state.edits` keys from `${chapterIndex}:${placementIndex}` → `${uuid}` on load.
- **Modify:** `src/components/editor/BRollEditor.jsx`:
  - Line 237-244 (selectIdentity match) — add uuid branch (preferred path for same-pipeline).
- **Modify:** `src/components/editor/BRollTrack.jsx`:
  - Edit-override lookup — read by `placement.uuid`, fallback to `${chapterIndex}:${placementIndex}`.
- **Create:** `server/services/__tests__/broll-placement-uuid.test.js` — Vitest tests for the helper.
- **Create:** `server/services/__tests__/broll-uuid-migration.test.js` — Vitest tests for the backfill migration.

---

## Task 1: Schema — `broll_placement_uuids` table + `placement_uuid` column

**Files:**
- Modify: `server/schema-pg.sql` (around line 112-131)
- Modify: `server/db.js` (migrations block)

- [ ] **Step 1: Add the side table + column to canonical schema**

In `server/schema-pg.sql`, find the `broll_searches` table definition. Replace:

```sql
CREATE TABLE IF NOT EXISTS broll_searches (
  id SERIAL PRIMARY KEY,
  plan_pipeline_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  placement_index INTEGER NOT NULL,
```

with:

```sql
CREATE TABLE IF NOT EXISTS broll_searches (
  id SERIAL PRIMARY KEY,
  plan_pipeline_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  placement_index INTEGER NOT NULL,
  placement_uuid TEXT,
```

Then add the new side table next to other table definitions (anywhere in the file, e.g. right after `broll_searches`):

```sql
-- Stable per-placement identity. Keyed by the LLM's positional location
-- (plan_pipeline_id, chapter_index, placement_index); UUID is never reused.
-- The LLM's broll_runs.output_text is intentionally NOT mutated — this is
-- the side-table approach so the run record stays a faithful copy of what
-- the model emitted.
CREATE TABLE IF NOT EXISTS broll_placement_uuids (
  id SERIAL PRIMARY KEY,
  plan_pipeline_id TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  placement_index INTEGER NOT NULL,
  uuid TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (plan_pipeline_id, chapter_index, placement_index)
);
```

Add indices at the bottom of the file (next to other `CREATE INDEX IF NOT EXISTS`):

```sql
CREATE INDEX IF NOT EXISTS idx_broll_searches_uuid ON broll_searches(plan_pipeline_id, placement_uuid);
CREATE INDEX IF NOT EXISTS idx_broll_placement_uuids_plan ON broll_placement_uuids(plan_pipeline_id);
```

- [ ] **Step 2: Add idempotent migrations to `db.js`**

In `server/db.js`, find the migrations cluster (look for the existing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` patterns). Add:

```javascript
await pool.query(`ALTER TABLE broll_searches ADD COLUMN IF NOT EXISTS placement_uuid TEXT`)
await pool.query(`CREATE INDEX IF NOT EXISTS idx_broll_searches_uuid ON broll_searches(plan_pipeline_id, placement_uuid)`)
await pool.query(`
  CREATE TABLE IF NOT EXISTS broll_placement_uuids (
    id SERIAL PRIMARY KEY,
    plan_pipeline_id TEXT NOT NULL,
    chapter_index INTEGER NOT NULL,
    placement_index INTEGER NOT NULL,
    uuid TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (plan_pipeline_id, chapter_index, placement_index)
  )
`)
await pool.query(`CREATE INDEX IF NOT EXISTS idx_broll_placement_uuids_plan ON broll_placement_uuids(plan_pipeline_id)`)
```

- [ ] **Step 3: Verify migration runs cleanly**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npm run dev:server 2>&1 | head -50
```

Expected: no errors mentioning `broll_searches`, `broll_placement_uuids`, or `placement_uuid`. Stop the server (Ctrl-C) once it logs "ready".

- [ ] **Step 4: Verify schema in DB**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node -e "import('./server/db.js').then(async m => {
  const cols = await m.db.prepare(\"SELECT column_name FROM information_schema.columns WHERE table_name='broll_searches'\").all()
  const tbl = await m.db.prepare(\"SELECT table_name FROM information_schema.tables WHERE table_name='broll_placement_uuids'\").get()
  console.log('broll_searches has placement_uuid:', cols.some(c => c.column_name === 'placement_uuid'))
  console.log('broll_placement_uuids exists:', !!tbl)
  process.exit(0)
})"
```

Expected: both `true`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/schema-pg.sql server/db.js
git commit -m "$(cat <<'EOF'
feat(db): broll_placement_uuids side table + placement_uuid column

New side table maps (plan_pipeline_id, chapter_index, placement_index)
to a stable UUID per placement — the LLM's broll_runs.output_text is
intentionally not mutated, so the run record stays a faithful copy
of what the model emitted. broll_searches gains a nullable
placement_uuid column indexed for the exclusion-set query in
_getPendingGpuPlacements. Backfill in a follow-up migration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Helper module — `broll-placement-uuid.js` (side-table-backed)

**Files:**
- Create: `server/services/broll-placement-uuid.js`
- Create: `server/services/__tests__/broll-placement-uuid.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/services/__tests__/broll-placement-uuid.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db.js'
import { getOrCreatePlacementUuid, ensurePlanUuids, lookupPlacementUuid } from '../broll-placement-uuid.js'

describe('broll-placement-uuid helper (side table)', () => {
  beforeEach(async () => {
    await db.prepare(`DELETE FROM broll_placement_uuids WHERE plan_pipeline_id LIKE ?`).run('test-uuid-helper-%')
    await db.prepare(`DELETE FROM broll_runs WHERE metadata_json LIKE ?`).run('%test-uuid-helper%')
  })

  it('getOrCreatePlacementUuid creates a new p_-prefixed uuid on first call', async () => {
    const planPid = 'test-uuid-helper-1'
    const uuid = await getOrCreatePlacementUuid(planPid, 0, 0)
    expect(uuid).toMatch(/^p_[a-z0-9]{12}$/)
  })

  it('getOrCreatePlacementUuid returns the SAME uuid on repeat calls (idempotent)', async () => {
    const planPid = 'test-uuid-helper-2'
    const a = await getOrCreatePlacementUuid(planPid, 0, 0)
    const b = await getOrCreatePlacementUuid(planPid, 0, 0)
    expect(a).toBe(b)
  })

  it('getOrCreatePlacementUuid returns DIFFERENT uuids for different positions', async () => {
    const planPid = 'test-uuid-helper-3'
    const a = await getOrCreatePlacementUuid(planPid, 0, 0)
    const b = await getOrCreatePlacementUuid(planPid, 0, 1)
    const c = await getOrCreatePlacementUuid(planPid, 1, 0)
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('getOrCreatePlacementUuid does NOT mutate broll_runs.output_text', async () => {
    const planPid = 'test-uuid-helper-4'
    const original = JSON.stringify({ placements: [{ description: 'A' }] })
    await db.prepare(
      `INSERT INTO broll_runs (metadata_json, output_text, status) VALUES (?, ?, 'complete')`
    ).run(JSON.stringify({ pipelineId: planPid, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex: 0 }), original)

    await getOrCreatePlacementUuid(planPid, 0, 0)

    const after = await db.prepare(`SELECT output_text FROM broll_runs WHERE metadata_json LIKE ?`).get(`%"pipelineId":"${planPid}"%`)
    expect(after.output_text).toBe(original) // byte-for-byte unchanged
  })

  it('ensurePlanUuids returns Map<chapterIndex, Map<placementIndex, uuid>> for all chapter placements', async () => {
    const planPid = 'test-uuid-helper-5'
    await db.prepare(
      `INSERT INTO broll_runs (metadata_json, output_text, status) VALUES (?, ?, 'complete')`
    ).run(JSON.stringify({ pipelineId: planPid, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex: 0 }),
          JSON.stringify({ placements: [{ description: 'A' }, { description: 'B' }] }))
    await db.prepare(
      `INSERT INTO broll_runs (metadata_json, output_text, status) VALUES (?, ?, 'complete')`
    ).run(JSON.stringify({ pipelineId: planPid, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex: 1 }),
          JSON.stringify({ placements: [{ description: 'C' }] }))

    const m = await ensurePlanUuids(planPid)
    expect(m.get(0).size).toBe(2)
    expect(m.get(1).size).toBe(1)
    expect(m.get(0).get(0)).toMatch(/^p_/)
    expect(m.get(0).get(1)).toMatch(/^p_/)
    expect(m.get(1).get(0)).toMatch(/^p_/)
    // All distinct
    const all = [m.get(0).get(0), m.get(0).get(1), m.get(1).get(0)]
    expect(new Set(all).size).toBe(3)
  })

  it('ensurePlanUuids is idempotent — returns same uuids on repeat call', async () => {
    const planPid = 'test-uuid-helper-6'
    await db.prepare(
      `INSERT INTO broll_runs (metadata_json, output_text, status) VALUES (?, ?, 'complete')`
    ).run(JSON.stringify({ pipelineId: planPid, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex: 0 }),
          JSON.stringify({ placements: [{ description: 'A' }] }))

    const m1 = await ensurePlanUuids(planPid)
    const m2 = await ensurePlanUuids(planPid)
    expect(m2.get(0).get(0)).toBe(m1.get(0).get(0))
  })

  it('lookupPlacementUuid returns null when no uuid has been assigned', async () => {
    const planPid = 'test-uuid-helper-7'
    const uuid = await lookupPlacementUuid(planPid, 0, 0)
    expect(uuid).toBe(null)
  })

  it('skips category != "broll" placements when building the map', async () => {
    const planPid = 'test-uuid-helper-8'
    await db.prepare(
      `INSERT INTO broll_runs (metadata_json, output_text, status) VALUES (?, ?, 'complete')`
    ).run(JSON.stringify({ pipelineId: planPid, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex: 0 }),
          JSON.stringify({ placements: [
            { description: 'broll item', category: 'broll' },
            { description: 'aroll item', category: 'aroll' }, // should be skipped
            { description: 'broll item 2' }, // no category = treated as broll
          ]}))

    const m = await ensurePlanUuids(planPid)
    // brollOnly indexing: position 0 = first broll, position 1 = third item (second is skipped)
    expect(m.get(0).size).toBe(2)
    expect(m.get(0).get(0)).toMatch(/^p_/)
    expect(m.get(0).get(1)).toMatch(/^p_/)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run server/services/__tests__/broll-placement-uuid.test.js
```

Expected: FAIL with "Cannot find module" / "is not a function".

- [ ] **Step 3: Implement the helper**

Create `server/services/broll-placement-uuid.js`:

```javascript
import { db } from '../db.js'

function newUuid() {
  const rand = (globalThis.crypto?.randomUUID?.() || (Date.now().toString(36) + Math.random().toString(36).slice(2)))
    .replace(/-/g, '')
    .slice(0, 12)
  return 'p_' + rand
}

/**
 * Read-only lookup. Returns the uuid for (planPipelineId, chapterIndex, placementIndex)
 * if one has been assigned, else null. Never writes.
 */
export async function lookupPlacementUuid(planPipelineId, chapterIndex, placementIndex) {
  const row = await db.prepare(
    `SELECT uuid FROM broll_placement_uuids WHERE plan_pipeline_id = ? AND chapter_index = ? AND placement_index = ?`
  ).get(planPipelineId, chapterIndex, placementIndex)
  return row?.uuid || null
}

/**
 * Get the uuid for (planPipelineId, chapterIndex, placementIndex), creating one
 * atomically if it doesn't exist. Idempotent (uses INSERT ... ON CONFLICT DO NOTHING
 * then re-SELECTs).
 *
 * Does NOT modify broll_runs.output_text — UUIDs live exclusively in the side table.
 */
export async function getOrCreatePlacementUuid(planPipelineId, chapterIndex, placementIndex) {
  const existing = await lookupPlacementUuid(planPipelineId, chapterIndex, placementIndex)
  if (existing) return existing

  const uuid = newUuid()
  await db.prepare(`
    INSERT INTO broll_placement_uuids (plan_pipeline_id, chapter_index, placement_index, uuid)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (plan_pipeline_id, chapter_index, placement_index) DO NOTHING
  `).run(planPipelineId, chapterIndex, placementIndex, uuid)

  // Re-SELECT in case a concurrent caller won the INSERT race.
  return await lookupPlacementUuid(planPipelineId, chapterIndex, placementIndex)
}

/**
 * For all broll-category placements across all chapter runs of a plan pipeline,
 * ensure a uuid exists in the side table. Reads broll_runs.output_text but never
 * mutates it. Returns Map<chapterIndex, Map<placementIndex, uuid>>.
 */
export async function ensurePlanUuids(planPipelineId) {
  const planRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${planPipelineId}"%`)
  const chapterRuns = planRuns.filter(r => {
    try {
      const m = JSON.parse(r.metadata_json || '{}')
      return m.isSubRun && m.stageName === 'Per-chapter B-Roll plan'
    } catch { return false }
  })

  const out = new Map()
  for (const r of chapterRuns) {
    const meta = JSON.parse(r.metadata_json || '{}')
    const chIdx = typeof meta.subIndex === 'number' ? meta.subIndex : 0

    const raw = r.output_text || ''
    const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '')
    let parsed
    try { parsed = JSON.parse(cleaned) } catch { continue }

    let items = parsed.placements || parsed.broll_placements || []
    if (!items.length) {
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v) && v.length && v[0]?.description) { items = v; break }
      }
    }
    if (!Array.isArray(items)) continue

    const chapterMap = new Map()
    let brollIdx = 0
    for (const p of items) {
      if (p?.category && p.category !== 'broll') continue
      const uuid = await getOrCreatePlacementUuid(planPipelineId, chIdx, brollIdx)
      chapterMap.set(brollIdx, uuid)
      brollIdx++
    }
    out.set(chIdx, chapterMap)
  }
  return out
}
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run server/services/__tests__/broll-placement-uuid.test.js
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/services/broll-placement-uuid.js server/services/__tests__/broll-placement-uuid.test.js
git commit -m "$(cat <<'EOF'
feat(broll): side-table-backed placement UUID helper

`getOrCreatePlacementUuid` returns a stable uuid for
(plan_pipeline_id, chapter_index, placement_index), creating one
atomically (INSERT ... ON CONFLICT DO NOTHING) on first call.
`ensurePlanUuids` walks all chapter runs of a plan and guarantees
every broll-category placement has a uuid, returning the full
Map<chapterIndex, Map<placementIndex, uuid>>. broll_runs.output_text
is only read — never mutated — so the LLM run record stays a faithful
copy of what the model emitted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: One-time backfill migration in `db.js`

**Files:**
- Modify: `server/services/broll-placement-uuid.js` (append `backfillPlacementUuids`)
- Modify: `server/db.js` (post-migrations section)
- Create: `server/services/__tests__/broll-uuid-migration.test.js`

- [ ] **Step 1: Write the failing test for backfill**

Create `server/services/__tests__/broll-uuid-migration.test.js`:

```javascript
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../../db.js'
import { backfillPlacementUuids } from '../broll-placement-uuid.js'

describe('backfillPlacementUuids', () => {
  beforeEach(async () => {
    await db.prepare(`DELETE FROM broll_placement_uuids WHERE plan_pipeline_id LIKE ?`).run('test-uuid-backfill-%')
    await db.prepare(`DELETE FROM broll_runs WHERE metadata_json LIKE ?`).run('%test-uuid-backfill%')
    await db.prepare(`DELETE FROM broll_searches WHERE plan_pipeline_id LIKE ?`).run('test-uuid-backfill-%')
  })

  it('populates broll_placement_uuids and fills broll_searches.placement_uuid for existing rows', async () => {
    const planPid = 'test-uuid-backfill-plan-1'
    await db.prepare(
      `INSERT INTO broll_runs (metadata_json, output_text, status) VALUES (?, ?, 'complete')`
    ).run(
      JSON.stringify({ pipelineId: planPid, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex: 0 }),
      JSON.stringify({ placements: [{ description: 'A' }, { description: 'B' }] })
    )
    await db.prepare(
      `INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, status)
       VALUES (?, 'test-batch', 0, 0, 'complete'), (?, 'test-batch', 0, 1, 'complete')`
    ).run(planPid, planPid)

    await backfillPlacementUuids()

    const sideTable = await db.prepare(
      `SELECT chapter_index, placement_index, uuid FROM broll_placement_uuids
       WHERE plan_pipeline_id = ? ORDER BY chapter_index, placement_index`
    ).all(planPid)
    expect(sideTable).toHaveLength(2)
    expect(sideTable[0].uuid).toMatch(/^p_/)
    expect(sideTable[1].uuid).toMatch(/^p_/)
    expect(sideTable[0].uuid).not.toBe(sideTable[1].uuid)

    const searches = await db.prepare(
      `SELECT chapter_index, placement_index, placement_uuid FROM broll_searches
       WHERE plan_pipeline_id = ? ORDER BY placement_index`
    ).all(planPid)
    expect(searches[0].placement_uuid).toBe(sideTable[0].uuid)
    expect(searches[1].placement_uuid).toBe(sideTable[1].uuid)
  })

  it('does NOT mutate broll_runs.output_text', async () => {
    const planPid = 'test-uuid-backfill-plan-2'
    const original = JSON.stringify({ placements: [{ description: 'A' }, { description: 'B' }] })
    await db.prepare(
      `INSERT INTO broll_runs (metadata_json, output_text, status) VALUES (?, ?, 'complete')`
    ).run(
      JSON.stringify({ pipelineId: planPid, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex: 0 }),
      original
    )

    await backfillPlacementUuids()

    const after = await db.prepare(`SELECT output_text FROM broll_runs WHERE metadata_json LIKE ?`).get(`%"pipelineId":"${planPid}"%`)
    expect(after.output_text).toBe(original) // byte-for-byte unchanged
  })

  it('is idempotent — running twice does not change data', async () => {
    const planPid = 'test-uuid-backfill-plan-3'
    await db.prepare(
      `INSERT INTO broll_runs (metadata_json, output_text, status) VALUES (?, ?, 'complete')`
    ).run(
      JSON.stringify({ pipelineId: planPid, isSubRun: true, stageName: 'Per-chapter B-Roll plan', subIndex: 0 }),
      JSON.stringify({ placements: [{ description: 'X' }] })
    )
    await db.prepare(`INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, status) VALUES (?, 'b', 0, 0, 'complete')`).run(planPid)

    await backfillPlacementUuids()
    const after1 = await db.prepare(`SELECT placement_uuid FROM broll_searches WHERE plan_pipeline_id = ?`).get(planPid)
    await backfillPlacementUuids()
    const after2 = await db.prepare(`SELECT placement_uuid FROM broll_searches WHERE plan_pipeline_id = ?`).get(planPid)

    expect(after2.placement_uuid).toBe(after1.placement_uuid)
  })
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run server/services/__tests__/broll-uuid-migration.test.js
```

Expected: FAIL with "backfillPlacementUuids is not a function".

- [ ] **Step 3: Implement `backfillPlacementUuids`**

Append to `server/services/broll-placement-uuid.js`:

```javascript
/**
 * One-time backfill: for every plan referenced from broll_searches OR with
 * complete chapter runs in broll_runs, ensure every broll-category placement
 * has a uuid in broll_placement_uuids. Then UPDATE any broll_searches row
 * with NULL placement_uuid by joining on (plan_pipeline_id, chapter_index,
 * placement_index).
 *
 * Idempotent. Safe to call on every server boot. Never touches broll_runs.
 */
export async function backfillPlacementUuids() {
  const fromSearches = await db.prepare(
    `SELECT DISTINCT plan_pipeline_id FROM broll_searches`
  ).all()
  const fromRuns = await db.prepare(
    `SELECT DISTINCT (metadata_json::jsonb->>'pipelineId') AS pid FROM broll_runs
     WHERE (metadata_json::jsonb->>'pipelineId') LIKE 'plan-%' AND status = 'complete'`
  ).all()
  const planIds = new Set([
    ...fromSearches.map(r => r.plan_pipeline_id),
    ...fromRuns.map(r => r.pid).filter(Boolean),
  ])

  let totalUuids = 0, totalSearchesFilled = 0
  for (const planPid of planIds) {
    const uuidsByChapter = await ensurePlanUuids(planPid)
    for (const m of uuidsByChapter.values()) totalUuids += m.size

    const rows = await db.prepare(
      `SELECT id, chapter_index, placement_index FROM broll_searches
       WHERE plan_pipeline_id = ? AND placement_uuid IS NULL`
    ).all(planPid)
    for (const row of rows) {
      const uuid = uuidsByChapter.get(row.chapter_index)?.get(row.placement_index)
      if (uuid) {
        await db.prepare(`UPDATE broll_searches SET placement_uuid = ? WHERE id = ?`).run(uuid, row.id)
        totalSearchesFilled++
      }
    }
  }
  console.log(`[backfillPlacementUuids] plans=${planIds.size} uuids_in_side_table=${totalUuids} searches_backfilled=${totalSearchesFilled}`)
}
```

- [ ] **Step 4: Wire backfill into `db.js` startup**

In `server/db.js`, after the schema migrations from Task 1, add (inside the same `try`/wrapper):

```javascript
// Backfill placement UUIDs (idempotent — safe to run on every boot)
try {
  const { backfillPlacementUuids } = await import('./services/broll-placement-uuid.js')
  await backfillPlacementUuids()
} catch (err) {
  console.error('[db.js] placement uuid backfill failed:', err.message)
}
```

- [ ] **Step 5: Run the test, expect PASS**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run server/services/__tests__/broll-uuid-migration.test.js
```

Expected: 3 tests pass.

- [ ] **Step 6: Boot the server and confirm backfill log appears**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npm run dev:server 2>&1 | grep -E "backfillPlacementUuids|placement uuid backfill"
```

Expected: one line like `[backfillPlacementUuids] plans=N uuids_in_side_table=M searches_backfilled=K`.

Stop the server. Re-boot:

```bash
npm run dev:server 2>&1 | grep -E "backfillPlacementUuids"
```

Expected: a line with `searches_backfilled=0` (idempotent — nothing left to do). Note: `uuids_in_side_table` may still report N>0 because `ensurePlanUuids` re-counts existing rows; only `searches_backfilled=0` proves idempotency.

- [ ] **Step 7: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/services/broll-placement-uuid.js server/services/__tests__/broll-uuid-migration.test.js server/db.js
git commit -m "$(cat <<'EOF'
feat(broll): boot-time backfill for placement_uuid (side table)

For every plan with chapter runs or broll_searches rows: ensure every
broll-category placement has a uuid in broll_placement_uuids, then
UPDATE broll_searches.placement_uuid for any NULL rows by joining on
(plan_pipeline_id, chapter_index, placement_index). Runs every server
boot; idempotent — re-runs find nothing to do. broll_runs.output_text
is read-only throughout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Materialize uuid on placement objects in `getBRollEditorData`

**Files:**
- Modify: `server/services/broll.js` (line 5101-5192)

- [ ] **Step 1: Add uuid to placement materialization**

In `server/services/broll.js`, find the loop at line 5101-5137. Replace:

```javascript
  // Flatten placements from all chapters
  const placements = []
  for (let chIdx = 0; chIdx < chapterRuns.length; chIdx++) {
    const raw = chapterRuns[chIdx].output_text || ''
    let parsed
    try {
      const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '')
      parsed = JSON.parse(cleaned)
    } catch { continue }

    // Find the placements array at any nesting
    let items = parsed.placements || parsed.broll_placements || []
    if (!items.length) {
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v) && v.length && v[0]?.description) { items = v; break }
      }
    }

    let brollIdx = 0
    for (let pIdx = 0; pIdx < items.length; pIdx++) {
      const p = items[pIdx]
      if (p.category && p.category !== 'broll') continue
      placements.push({
        index: placements.length,
        chapterIndex: chIdx,
        placementIndex: brollIdx++,
        start: p.start,
        end: p.end,
        audio_anchor: p.audio_anchor || '',
        description: p.description || '',
        function: p.function || '',
        type_group: p.type_group || '',
        source_feel: p.source_feel || '',
        style: p.style || {},
        searchStatus: 'pending',
        results: [],
      })
    }
  }
```

with:

```javascript
  // Ensure side-table uuids exist for every placement in this plan (idempotent).
  // Returns Map<chapterIndex, Map<placementIndex, uuid>>. Reads broll_runs.output_text
  // but does NOT mutate it.
  const { ensurePlanUuids } = await import('./broll-placement-uuid.js')
  const uuidsByChapter = await ensurePlanUuids(planPipelineId)

  // Flatten placements from all chapters
  const placements = []
  for (let chIdx = 0; chIdx < chapterRuns.length; chIdx++) {
    const raw = chapterRuns[chIdx].output_text || ''
    let parsed
    try {
      const cleaned = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '')
      parsed = JSON.parse(cleaned)
    } catch { continue }

    let items = parsed.placements || parsed.broll_placements || []
    if (!items.length) {
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v) && v.length && v[0]?.description) { items = v; break }
      }
    }

    let brollIdx = 0
    for (let pIdx = 0; pIdx < items.length; pIdx++) {
      const p = items[pIdx]
      if (p.category && p.category !== 'broll') continue
      placements.push({
        index: placements.length,
        uuid: uuidsByChapter.get(chIdx)?.get(brollIdx) || null, // ← stable identity from side table
        chapterIndex: chIdx,
        placementIndex: brollIdx++,
        start: p.start,
        end: p.end,
        audio_anchor: p.audio_anchor || '',
        description: p.description || '',
        function: p.function || '',
        type_group: p.type_group || '',
        source_feel: p.source_feel || '',
        style: p.style || {},
        searchStatus: 'pending',
        results: [],
      })
    }
  }
```

> The `ensurePlanUuids` call is idempotent and cheap once the side table is populated (one SELECT per chapter run, no INSERTs after the first call). It runs once per `getBRollEditorData` invocation — the side-table approach trades the ~negligible read overhead for keeping `broll_runs.output_text` byte-for-byte equal to the LLM emission.

- [ ] **Step 2: Update broll_searches → placement match to prefer uuid**

In `server/services/broll.js`, find line 5177:

```javascript
    for (const row of queueRows) {
      const match = placements.find(p => p.chapterIndex === row.chapter_index && p.placementIndex === row.placement_index)
      if (!match) continue
```

Replace with:

```javascript
    for (const row of queueRows) {
      // Prefer uuid match (stable across reorders/edits); fall back to indices for legacy rows.
      let match = null
      if (row.placement_uuid) {
        match = placements.find(p => p.uuid === row.placement_uuid)
      }
      if (!match) {
        match = placements.find(p => p.chapterIndex === row.chapter_index && p.placementIndex === row.placement_index)
      }
      if (!match) continue
```

- [ ] **Step 3: Quick smoke check via the API**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npm run dev:server &
SERVER_PID=$!
sleep 5
# Replace 225 with a real video id from your local DB if 225 doesn't exist
curl -s "http://localhost:3000/api/broll/editor-data?videoId=225&pipelineId=$(curl -s 'http://localhost:3000/api/broll/pipelines?videoId=225' | jq -r '.pipelines[] | select(.id | startswith(\"plan-\")) | .id' | head -1)" | jq '.placements[0] | {index, uuid, chapterIndex, placementIndex, description}'
kill $SERVER_PID
```

Expected: `uuid` field present and starts with `p_`. (If the URL/auth shape doesn't match, just hit the running app in a browser at `/admin/broll?id=...` and inspect the editor-data network response — verify `placements[0].uuid` is set.)

- [ ] **Step 4: Run all server tests**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run server/
```

Expected: all green. (If a test breaks because it asserted the exact placement shape without uuid, update its expected shape to include `uuid: expect.stringMatching(/^p_/)`.)

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/services/broll.js server/services/broll-placement-uuid.js
git commit -m "$(cat <<'EOF'
feat(broll): expose placement.uuid in getBRollEditorData

Materialized placement objects now carry a stable `uuid` field looked
up from the broll_placement_uuids side table (ensurePlanUuids
guarantees a row exists for every broll-category placement). The
broll_searches → placement reconciliation prefers matching by
placement_uuid, falling back to (chapter_index, placement_index)
for legacy rows that pre-date the migration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Pending-placement queue + INSERT in `_getPendingGpuPlacements`

**Files:**
- Modify: `server/services/broll.js` (lines 2122-2135 INSERT, lines 2283-2326 pending logic, lines 2220-2280 buildSearchParams)

- [ ] **Step 1: Pass uuid through `_getPendingGpuPlacements`**

In `server/services/broll.js`, find `_getPendingGpuPlacements` (line 2283). Replace its body with:

```javascript
async function _getPendingGpuPlacements(planPipelineId) {
  // Ensure side-table uuids exist before we read placement identity.
  const { ensurePlanUuids } = await import('./broll-placement-uuid.js')
  const uuidsByChapter = await ensurePlanUuids(planPipelineId)

  // Load plan placements
  const planRuns = await db.prepare(
    `SELECT * FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete' ORDER BY id`
  ).all(`%"pipelineId":"${planPipelineId}"%`)
  const chapterRuns = planRuns.filter(r => {
    try { return JSON.parse(r.metadata_json || '{}').isSubRun && JSON.parse(r.metadata_json || '{}').stageName === 'Per-chapter B-Roll plan' }
    catch { return false }
  }).sort((a, b) => (JSON.parse(a.metadata_json || '{}').subIndex || 0) - (JSON.parse(b.metadata_json || '{}').subIndex || 0))

  const allPlacements = []
  for (let chIdx = 0; chIdx < chapterRuns.length; chIdx++) {
    try {
      const parsed = extractJSON(chapterRuns[chIdx].output_text || '')
      const items = parsed.placements || parsed
      if (!Array.isArray(items)) continue
      const brollOnly = items.filter(p => !p.category || p.category === 'broll')
      const m = JSON.parse(chapterRuns[chIdx].metadata_json || '{}')
      const realChIdx = typeof m.subIndex === 'number' ? m.subIndex : chIdx
      for (let pIdx = 0; pIdx < brollOnly.length; pIdx++) {
        const uuid = uuidsByChapter.get(realChIdx)?.get(pIdx) || null
        allPlacements.push({ pid: planPipelineId, uuid, chapterIndex: realChIdx, placementIndex: pIdx })
      }
    } catch {}
  }

  // Find which already have GPU results (legacy broll_runs)
  const searchRuns = await db.prepare(
    `SELECT metadata_json FROM broll_runs WHERE metadata_json LIKE ? AND status = 'complete'`
  ).all(`%"pipelineId":"bs-${planPipelineId}-%`)
  const searched = new Set()       // legacy index-based exclusions
  const searchedUuids = new Set()  // uuid-based exclusions
  for (const r of searchRuns) {
    try {
      const m = JSON.parse(r.metadata_json || '{}')
      if (m.isSubRun) searched.add(`${m.chapterIndex}:${m.placementIndex}`)
    } catch {}
  }

  // Also exclude placements already in broll_searches queue (prefer uuid, fall back to indices)
  const queuedRows = await db.prepare(
    `SELECT chapter_index, placement_index, placement_uuid FROM broll_searches
     WHERE plan_pipeline_id = ? AND status IN ('waiting', 'running', 'complete')`
  ).all(planPipelineId)
  for (const row of queuedRows) {
    if (row.placement_uuid) searchedUuids.add(row.placement_uuid)
    else searched.add(`${row.chapter_index}:${row.placement_index}`)
  }

  return allPlacements.filter(p => {
    if (p.uuid && searchedUuids.has(p.uuid)) return false
    if (searched.has(`${p.chapterIndex}:${p.placementIndex}`)) return false
    return true
  })
}
```

- [ ] **Step 2: Update `_buildSearchParams` to pass uuid through**

In `server/services/broll.js`, find `_buildSearchParams` (around line 2220). Change its signature from:

```javascript
async function _buildSearchParams(planPipelineId, chapterIndex, placementIndex) {
```

to:

```javascript
async function _buildSearchParams(planPipelineId, chapterIndex, placementIndex, uuid = null) {
```

The function body that looks up keywords by `chapterIndex`/`placementIndex` stays as-is (kw-pipeline outputs are intrinsically positional within their chapter run). Just thread `uuid` through to wherever the result is used. Look at the function — if it returns `{ brief, keywords, description }`, leave the return shape but add `uuid` so callers can pass it to the INSERT:

```javascript
return { brief, keywords, description: p.description || '', uuid }
```

(Add `uuid: p.uuid || uuid` actually — prefer the uuid baked into the placement object, fall back to the argument.)

- [ ] **Step 3: Update the INSERT into `broll_searches`**

In `server/services/broll.js`, find the INSERT at line 2129-2132:

```javascript
        const ins = await db.prepare(`
          INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, variant_label, description, brief, keywords_json, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting')
        `).run(item.pid, pipelineId, item.chapterIndex, item.placementIndex, variantLabel, description, brief, JSON.stringify(keywords))
```

Replace with:

```javascript
        const { brief, keywords, description, uuid: builtUuid } = await _buildSearchParams(item.pid, item.chapterIndex, item.placementIndex, item.uuid)
        if (!keywords.length) {
          throw new Error(`No keywords for ${variantLabel} ch${item.chapterIndex} p${item.placementIndex} after generation — refusing to send empty payload to GPU`)
        }
        const placementUuid = item.uuid || builtUuid || null
        const ins = await db.prepare(`
          INSERT INTO broll_searches (plan_pipeline_id, batch_id, chapter_index, placement_index, placement_uuid, variant_label, description, brief, keywords_json, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting')
        `).run(item.pid, pipelineId, item.chapterIndex, item.placementIndex, placementUuid, variantLabel, description, brief, JSON.stringify(keywords))
```

> The first three lines of the replacement (extracting `brief, keywords, description` from `_buildSearchParams`) replace whatever was already there at line 2125 — verify when editing.

- [ ] **Step 4: Smoke test the search-next-batch endpoint end-to-end**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npm run dev:server &
SERVER_PID=$!
sleep 5
```

In a browser, open the editor for an existing video, click "Search next 10". Then:

```bash
node -e "import('./server/db.js').then(async m => { const rows = await m.db.prepare(\"SELECT id, chapter_index, placement_index, placement_uuid FROM broll_searches WHERE batch_id LIKE 'search-batch-%' ORDER BY id DESC LIMIT 10\").all(); console.log(rows); process.exit(0) })"
kill $SERVER_PID
```

Expected: every recent row has `placement_uuid` populated (not null).

- [ ] **Step 5: Run tests**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run server/
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/services/broll.js
git commit -m "$(cat <<'EOF'
feat(broll): use placement_uuid as primary key for search queue

_getPendingGpuPlacements now resolves uuid per pending item and uses
it as the exclusion-set key (with index-based fallback for legacy
rows). The broll_searches INSERT writes placement_uuid alongside the
existing chapter_index/placement_index columns. _buildSearchParams
threads uuid through but keeps kw-pipeline lookups positional, since
keyword outputs are intrinsically tied to chapter run array order.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Single-placement search endpoint accepts `placementUuid`

**Files:**
- Modify: `server/routes/broll.js` (lines 1015-1031)
- Modify: `server/services/broll.js` (`searchSinglePlacement` — locate via grep)
- Modify: `src/components/editor/useBRollEditorState.js` (lines 397, 421)

- [ ] **Step 1: Find `searchSinglePlacement`'s signature**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
grep -n "function searchSinglePlacement\|export.*searchSinglePlacement" server/services/broll.js
```

Expected: one or two matches (the function definition). Note its line number — call it L.

- [ ] **Step 2: Update endpoint to accept uuid**

In `server/routes/broll.js`, find `router.post('/pipeline/:pipelineId/search-placement'...)` at line 1015. Replace:

```javascript
router.post('/pipeline/:pipelineId/search-placement', requireAuth, async (req, res) => {
  const { pipelineId } = req.params
  const { chapterIndex, placementIndex, description, style, sources } = req.body
  if (chapterIndex == null || placementIndex == null) {
    return res.status(400).json({ error: 'chapterIndex and placementIndex required' })
  }
  const overrides = { description, style, sources }
  const result = await searchSinglePlacement(pipelineId, chapterIndex, placementIndex, overrides)
  res.json(result)
})
```

with:

```javascript
router.post('/pipeline/:pipelineId/search-placement', requireAuth, async (req, res) => {
  const { pipelineId } = req.params
  const { placementUuid, chapterIndex, placementIndex, description, style, sources } = req.body
  if (!placementUuid && (chapterIndex == null || placementIndex == null)) {
    return res.status(400).json({ error: 'placementUuid OR (chapterIndex, placementIndex) required' })
  }
  const overrides = { description, style, sources }
  const result = await searchSinglePlacement(pipelineId, { placementUuid, chapterIndex, placementIndex }, overrides)
  res.json(result)
})
```

- [ ] **Step 3: Update `searchSinglePlacement` signature**

In `server/services/broll.js`, change the function signature at line L (from Step 1) from:

```javascript
async function searchSinglePlacement(planPipelineId, chapterIndex, placementIndex, overrides = {}) {
```

to:

```javascript
async function searchSinglePlacement(planPipelineId, identity, overrides = {}) {
  // identity = { placementUuid?, chapterIndex?, placementIndex? }
  let { placementUuid, chapterIndex, placementIndex } = identity || {}

  // If only uuid was given, resolve to (chapterIndex, placementIndex) using ensurePlanUuids.
  if (placementUuid && (chapterIndex == null || placementIndex == null)) {
    const { ensurePlanUuids } = await import('./broll-placement-uuid.js')
    const uuidsByChapter = await ensurePlanUuids(planPipelineId)
    outer: for (const [chIdx, m] of uuidsByChapter.entries()) {
      for (const [pIdx, u] of m.entries()) {
        if (u === placementUuid) { chapterIndex = chIdx; placementIndex = pIdx; break outer }
      }
    }
    if (chapterIndex == null || placementIndex == null) {
      throw new Error(`searchSinglePlacement: uuid ${placementUuid} not found in plan ${planPipelineId}`)
    }
  }

  // If only indices were given, resolve uuid for the INSERT.
  if (!placementUuid) {
    const { ensurePlanUuids } = await import('./broll-placement-uuid.js')
    const uuidsByChapter = await ensurePlanUuids(planPipelineId)
    placementUuid = uuidsByChapter.get(chapterIndex)?.get(placementIndex) || null
  }
```

Then within the function body, find the INSERT into `broll_searches` (if any — `searchSinglePlacement` may insert into the queue or it may execute the search inline; read it carefully). If it inserts, add `placement_uuid` to the INSERT just like Task 5 Step 3.

- [ ] **Step 4: Update frontend caller in `useBRollEditorState.js`**

In `src/components/editor/useBRollEditorState.js`, replace lines 397-400:

```javascript
      const result = await apiPost(`/broll/pipeline/${planPipelineId}/search-placement`, {
        chapterIndex: placement.chapterIndex,
        placementIndex: placement.placementIndex,
      })
```

with:

```javascript
      const result = await apiPost(`/broll/pipeline/${planPipelineId}/search-placement`, {
        placementUuid: placement.uuid,
        chapterIndex: placement.chapterIndex,   // kept for legacy server fallback
        placementIndex: placement.placementIndex,
      })
```

Apply the same change to lines 421-425 (`searchPlacementCustom`).

- [ ] **Step 5: Smoke test single-placement search**

In the editor UI, click an individual b-roll placement's "Search" button (or similar single-trigger). Verify the network request payload includes `placementUuid`. Verify the resulting `broll_searches` row has `placement_uuid` set:

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node -e "import('./server/db.js').then(async m => { const r = await m.db.prepare(\"SELECT id, plan_pipeline_id, chapter_index, placement_index, placement_uuid, status FROM broll_searches ORDER BY id DESC LIMIT 1\").get(); console.log(r); process.exit(0) })"
```

Expected: `placement_uuid` populated on the latest row.

- [ ] **Step 6: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/routes/broll.js server/services/broll.js src/components/editor/useBRollEditorState.js
git commit -m "$(cat <<'EOF'
feat(broll): single-placement search endpoint accepts placementUuid

POST /broll/pipeline/:pipelineId/search-placement now takes
placementUuid as the primary identity, with (chapterIndex,
placementIndex) preserved as legacy fallback for any out-of-band
caller. searchSinglePlacement resolves uuid↔indices in both
directions and writes placement_uuid into broll_searches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manifest endpoint keys by `placementUuid`

**Files:**
- Modify: `server/routes/broll.js` (lines 145-162)

- [ ] **Step 1: Read current manifest code**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
sed -n '140,170p' server/routes/broll.js
```

Note the exact shape of the manifest dict. The audit reported it uses `${chapterIndex}:${placementIndex}` as the key.

- [ ] **Step 2: Switch manifest dict to keyed-by-uuid**

In `server/routes/broll.js`, find the manifest endpoint (line 145-162). Replace the dict-building section so the key is `row.placement_uuid` when present, falling back to `${row.chapter_index}:${row.placement_index}`. Concretely:

```javascript
// before (illustrative — actual code may differ slightly):
const manifest = {}
for (const row of rows) {
  manifest[`${row.chapter_index}:${row.placement_index}`] = row
}
```

becomes:

```javascript
const manifest = {}
for (const row of rows) {
  const key = row.placement_uuid || `${row.chapter_index}:${row.placement_index}`
  manifest[key] = row
}
```

> If the manifest is consumed by frontend code, audit those readers (`grep -rn 'manifest\[' src/`) and update them to read by `placement.uuid` first. Be precise — list every reader and update it.

- [ ] **Step 3: Smoke test**

Reload the editor, watch the manifest network request, verify it returns uuid-keyed entries.

- [ ] **Step 4: Run all tests**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/routes/broll.js src/
git commit -m "$(cat <<'EOF'
refactor(broll): manifest endpoint keys entries by placement_uuid

Falls back to ${chapter_index}:${placement_index} for any legacy
row that pre-dates the placement_uuid backfill. Frontend readers
updated in lockstep.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Frontend selectIdentity prefers uuid

**Files:**
- Modify: `src/components/editor/BRollEditor.jsx` (lines 116-167, 222-250)
- Modify: `src/components/editor/BRollTrack.jsx` (line 96-100, edit-override lookup)

- [ ] **Step 1: Update selectIdentity match logic**

In `src/components/editor/BRollEditor.jsx`, find the block at lines 237-244:

```javascript
    if (typeof pending === 'object') {
      let match = null
      if (pending.userPlacementId) {
        match = brollState.placements.find(p => p.userPlacementId === pending.userPlacementId)
      } else if (pending.chapterIndex != null && pending.placementIndex != null) {
        match = brollState.placements.find(p =>
          p.chapterIndex === pending.chapterIndex && p.placementIndex === pending.placementIndex
        )
      }
```

Replace with:

```javascript
    if (typeof pending === 'object') {
      let match = null
      if (pending.uuid) {
        // Same-pipeline (or cross-pipeline if uuids ever align): the strongest identity.
        match = brollState.placements.find(p => p.uuid === pending.uuid)
      }
      if (!match && pending.userPlacementId) {
        match = brollState.placements.find(p => p.userPlacementId === pending.userPlacementId)
      }
      if (!match && pending.chapterIndex != null && pending.placementIndex != null) {
        // Cross-variant fallback: different plan = different uuids, so position-based match
        // is the right heuristic for "the same chapter/index slot in another variant".
        match = brollState.placements.find(p =>
          p.chapterIndex === pending.chapterIndex && p.placementIndex === pending.placementIndex
        )
      }
```

- [ ] **Step 2: Update the comment block at lines 222-225**

Replace:

```javascript
  //   - { chapterIndex, placementIndex, userPlacementId } — stable cross-variant identity (preferred)
  //   - bare number — legacy / direct-index path
```

with:

```javascript
  //   - { uuid } — same-pipeline stable identity (preferred when staying in one variant)
  //   - { chapterIndex, placementIndex } — cross-variant identity (different plan = different uuids)
  //   - { userPlacementId } — user paste/cross-drag identity (preserved across variants in editor state)
  //   - bare number — legacy / direct-index path
```

- [ ] **Step 3: Update `handleVariantActivate` to include uuid**

Find `handleVariantActivate` around line 116. Wherever it constructs the `selectIdentity` object passed to the next variant, ensure it includes `uuid` from the currently-selected placement. Example shape:

```javascript
const selectIdentity = {
  uuid: currentPlacement?.uuid,
  chapterIndex: currentPlacement?.chapterIndex,
  placementIndex: currentPlacement?.placementIndex,
  userPlacementId: currentPlacement?.userPlacementId,
}
```

(Audit the actual current code first — there may be 1-2 call sites.)

- [ ] **Step 4: Update BRollTrack edit-override lookup**

In `src/components/editor/BRollTrack.jsx`, find the edit-override lookup that uses `${chapterIndex}:${placementIndex}` as a key (the audit reported one in `BRollTrack.jsx`). Change reads to:

```javascript
const editKey = placement.uuid || `${placement.chapterIndex}:${placement.placementIndex}`
const override = edits[editKey]
```

- [ ] **Step 5: Smoke test**

Open the editor for a video that has multiple variants. Click "Search next 10" on variant A; switch to variant B and back. Verify selection state survives. Open DevTools, log the selected `placement.uuid` and confirm it matches what's in the URL/state.

- [ ] **Step 6: Run vitest**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run
```

Expected: all green (this lands on the `vitest 131/131` baseline — should still be 131/131 plus the new tests added in Tasks 2-3).

- [ ] **Step 7: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/BRollEditor.jsx src/components/editor/BRollTrack.jsx
git commit -m "$(cat <<'EOF'
feat(broll-editor): selectIdentity prefers placement.uuid

Order of preference for resolving a pending selection across data
loads / variant switches: uuid → userPlacementId → (chapterIndex,
placementIndex) → bare number. uuid is the right key when the user
stays inside one variant (a placement keeps its uuid across data
refetches even if its array index shifts). Index-based fallback
remains for cross-variant matching, which is intentionally
position-based (different plans = different uuids).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Migrate `broll_editor_state.edits` to uuid-keyed dict

**Files:**
- Modify: `src/components/editor/useBRollEditorState.js` (LOAD_EDITOR_STATE reducer or wherever `edits` is loaded)
- Possibly modify: `server/routes/broll.js` (whatever endpoint serves editor state)

- [ ] **Step 1: Identify the edits-key shape today**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
grep -n "edits\[" src/components/editor/ server/routes/ server/services/ 2>/dev/null
```

For each occurrence: read the surrounding context, note whether the key is `${chapterIndex}:${placementIndex}` or already-uuid.

- [ ] **Step 2: One-shot client-side migration on load**

In `src/components/editor/useBRollEditorState.js`, find the reducer case that loads editor state (likely `LOAD_EDITOR_STATE`). Add a normalization step before the edits dict is stored:

```javascript
// Migrate legacy edit keys: "${chIdx}:${pIdx}" → "${uuid}"
function migrateEditsToUuid(edits, placements) {
  if (!edits || !placements?.length) return edits || {}
  const out = {}
  for (const [key, value] of Object.entries(edits)) {
    if (key.startsWith('p_') || key.startsWith('u_')) {
      out[key] = value // already uuid-keyed
      continue
    }
    const [chStr, pStr] = key.split(':')
    const chIdx = Number(chStr), pIdx = Number(pStr)
    const match = placements.find(p => p.chapterIndex === chIdx && p.placementIndex === pIdx)
    out[match?.uuid || key] = value // fall through with original key if no placement found
  }
  return out
}
```

Apply it where the reducer assigns edits from the server payload.

- [ ] **Step 3: Persist back in uuid-keyed shape**

When the editor state is saved (find the SAVE / mutation site for `broll_editor_state`), the migrated dict naturally writes back uuid-keyed. Verify by reading the row after a save:

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node -e "import('./server/db.js').then(async m => { const r = await m.db.prepare(\"SELECT edits_json FROM broll_editor_state ORDER BY updated_at DESC NULLS LAST LIMIT 1\").get(); console.log(JSON.stringify(JSON.parse(r?.edits_json || '{}'), null, 2)); process.exit(0) })"
```

> Adjust the SELECT to match the actual table/column name — search `server/services/broll.js` for `broll_editor_state` to confirm the column name (could be `state_json` instead of `edits_json`).

Expected: dict keys are uuids (start with `p_` or `u_`), not `0:0` etc.

- [ ] **Step 4: Smoke test edits**

In the editor UI: edit a placement (change description, hide it, whatever the existing edit affordance is), reload the page. Verify the edit persisted.

- [ ] **Step 5: Run vitest**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add src/components/editor/
git commit -m "$(cat <<'EOF'
refactor(broll-editor): rekey edits dict by placement.uuid on load

One-shot client-side migration: when LOAD_EDITOR_STATE returns a
dict keyed by "${chIdx}:${pIdx}", remap each entry to its
placement.uuid using the freshly-loaded placements list. Future
saves persist uuid-keyed, so the migration is amortized to once
per user per pipeline. Legacy keys for which no placement matches
are passed through unchanged (graceful degradation).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Verification pass

**Files:** none (read-only verification)

- [ ] **Step 1: Full vitest run**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npx vitest run
```

Expected: all green. Baseline was 131/131; expect ~135-138 after this plan's new tests.

- [ ] **Step 2: Manual smoke matrix**

Open the app locally. Walk through each scenario, ticking off here:

- [ ] Fresh video → run plan → run "Search b-roll" from `/editor/:id/brolls/strategy/plan` → editor opens → all placements show search results. Inspect a `broll_searches` row: `placement_uuid` populated.
- [ ] Existing video with already-completed searches → load editor → all results visible (legacy index-fallback path works).
- [ ] In editor, click "Search next 10" → 10 new rows appear with `placement_uuid` populated. `broll_searches` shows no orphans.
- [ ] In editor, edit a single placement's description, click "Search this one" (or whatever the per-placement search affordance is). Verify the new `broll_searches` row has `placement_uuid` matching the placement's `uuid`.
- [ ] Switch between plan variants. Selection survives. selectIdentity finds the right cross-variant placement.
- [ ] Hide a placement (edit override) → reload page → still hidden. (Confirms `edits` migration succeeded.)
- [ ] User paste / cross-drag a placement → `userPlacementId` still works, drag-cross undo still works.
- [ ] Reset a video group → all `broll_searches` and chapter `broll_runs` deleted (existing behavior unchanged).

- [ ] **Step 3: DB sanity**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node -e "import('./server/db.js').then(async m => {
  const total = await m.db.prepare('SELECT COUNT(*) AS n FROM broll_searches').get()
  const withUuid = await m.db.prepare('SELECT COUNT(*) AS n FROM broll_searches WHERE placement_uuid IS NOT NULL').get()
  const withoutUuid = await m.db.prepare('SELECT COUNT(*) AS n FROM broll_searches WHERE placement_uuid IS NULL').get()
  console.log({ total: total.n, withUuid: withUuid.n, withoutUuid: withoutUuid.n })
  process.exit(0)
})"
```

Expected: `withoutUuid` is small — should be only rows whose chapter run output_text is missing or unparseable (truly orphaned). `withUuid + withoutUuid === total`.

- [ ] **Step 4: Final commit (verification artifacts only — no code)**

If you produced any verification log files / screenshots, commit them under `docs/superpowers/verification/`. Otherwise no commit needed.

- [ ] **Step 5: Do NOT push**

Per project convention: leave commits local. The user explicitly approves pushes per task.

---

## Self-Review Checklist (run before handing off)

- [ ] Every reference to `chapter_index, placement_index` as a primary key has either been updated to use uuid OR retained as a documented legacy fallback. Grep: `grep -rn 'chapter_index.*placement_index\|chapterIndex.*placementIndex' server/ src/` — every hit accounted for.
- [ ] No placeholders in plan ("TBD", "implement later", etc.). Grep this file for those strings.
- [ ] Method/field names consistent: it's `placement.uuid` (not `placementId`, `placement_id`, or `puuid`) on the placement object; `placement_uuid` (snake_case) in DB columns and JSON request bodies use `placementUuid` (camelCase).
- [ ] kw-pipeline outputs (the `kw-${pid}-...` runs) are NOT migrated — they stay positional within their chapter run. This is correct: kw outputs are derived per chapter, not per-placement-identity.
- [ ] Cross-variant `selectIdentity` is intentionally left position-based. If the user later wants UUIDs to flow across plan variants (i.e., "the same placement" in different variants), that's a separate plan: it requires the LLM to emit stable IDs OR a per-video stable-id table that maps (videoId, audio_anchor) → uuid.
- [ ] Backfill is idempotent and runs on every server boot via `db.js`.
- [ ] User placements (`userPlacementId`) are not regressed — their identity is preserved end-to-end.

---

## Risks Mitigated by This Plan

| Risk | Mitigation |
|---|---|
| Old `broll_searches` rows have no UUID | Backfill (Task 3) populates them by joining on (plan_pipeline_id, chapter_index, placement_index) → side table. Only fails for rows whose chapter run is missing/unparseable, which were already orphaned. |
| Future placement reorder feature would silently misalign UUIDs | **Open issue**: side-table is keyed by (plan, ch, pl). A future "reorder placements" feature MUST update `broll_placement_uuids` rows in the same transaction as the reorder, otherwise UUIDs detach from their placements. Today there's no reorder UI, so this is latent. Addressed by adding a code comment in the helper module flagging this requirement, plus a TODO pinned in `docs/superpowers/specs/`. |
| Cross-variant selection breaks | selectIdentity falls back to (chapterIndex, placementIndex) when uuid doesn't match (intended: different variants have different uuids). |
| User placement (`userPlacementId`) regressions | Untouched — `uuid` is additive; existing userPlacementId code paths still run. |
| Frontend `edits` dict has stale index-based keys | One-shot migration on load (Task 9). Idempotent — running twice is a no-op. |
| Manifest endpoint consumers crash on key shape change | Updated in lockstep (Task 7) with audit of `manifest[` readers. |
| LLM output_text integrity | **Preserved**: we never mutate `broll_runs.output_text`. UUIDs live in the `broll_placement_uuids` side table. The run record stays a faithful copy of what the model emitted. |

---

## What This Plan Does NOT Do (and why)

- **Does not change the LLM prompt** to emit UUIDs. Server-side assignment is simpler, deterministic, and avoids retraining/prompt-engineering risk.
- **Does not mutate `broll_runs.output_text`.** UUIDs live in the `broll_placement_uuids` side table so the LLM run record stays a faithful copy of what the model emitted.
- **Does not unify `userPlacementId` and chapter-derived uuid** into one field name. They have different prefixes (`u_` vs `p_`), different lifecycles (user-paste vs LLM-output), and `userPlacementId` is referenced in too many places (drag-cross, undo, sourceUserPlacementId, etc.) to rename safely without a separate refactor. Both fields are exposed on the placement object; downstream code reads `placement.uuid` (which is set for both kinds).
- **Does not align UUIDs across plan variants.** Each variant is its own LLM run with its own placements. Cross-variant identity is positional today and stays positional after this plan. Adding cross-variant UUIDs is a separate (harder) problem.
- **Does not solve future placement-reorder UUID continuity.** The side-table keyed by `(plan_pipeline_id, chapter_index, placement_index)` means any future reorder UI must explicitly update `broll_placement_uuids` rows alongside the reorder. Flagged in Risks. If a reorder feature is added later, the right move is to switch to anchor-by-content (e.g., audio_anchor + start) or migrate the side-table to be keyed by an immutable surrogate ID — out of scope here.
