# Upload Config Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-page AI Rough Cut configuration with a six-step upload flow (upload → libraries → audience → references → path → transcribe), matching mockups in `~/Downloads/Adpunk/`. Persist library subscriptions, target audience, and workflow-automation path to `video_groups`. Route b-roll pipeline pause/resume behavior off the chosen path.

**Architecture:** Wave 1 (one agent, sequential) scaffolds shared UI primitives, orchestrator, backend columns, and placeholder step files — the flow navigates end-to-end through stubs. Wave 2 (four agents, parallel) each fill in one step + owned backend work without file conflicts.

**Tech Stack:** React 19 + Vite + Tailwind, Express + pg/sql.js, vitest (server-only tests).

**Spec:** `docs/specs/2026-04-24-upload-config-redesign-design.md`

**Reference mockups** (read these before porting UI): `~/Downloads/Adpunk/components.jsx`, `stepper.jsx`, `step-libraries.jsx`, `step-audience.jsx`, `step-references.jsx`, `step-path.jsx`, `step-done.jsx`, `Upload Configuration.html`.

---

## Conventions

- **Imports**: use ES modules, React 19 hooks. `.jsx` extension for components.
- **Tailwind tokens** (from existing app): `lime`, `primary-container`, `surface-container-low/high/highest`, `on-surface`, `on-surface-variant`, `muted`, `border-subtle`, `purple-accent`, `teal`. Design colors `#cefc00`, `#c180ff`, `#2dd4bf` map to `lime`, `purple-accent`, `teal`.
- **Material Symbols**: already loaded globally. Use `<span className="material-symbols-outlined">icon_name</span>`.
- **Icons from lucide-react**: used sparingly in existing modals — prefer Material Symbols for the new flow to match the design.
- **API helpers**: `apiPost`, `apiPut`, `apiDelete`, `useApi` from `src/hooks/useApi.js`.
- **DB**: SQLite for local dev (`server/schema.sql`), Postgres for deployed (`server/schema-pg.sql`). Migrations run via `ALTER TABLE` in `server/db.js` init, using `IF NOT EXISTS` where the backend supports it.
- **Tests**: `server/**/__tests__/*.test.js`. Frontend test infra is not set up — do not add it.
- **File paths** below are relative to `/Users/laurynas/Desktop/one last /transcript-eval/` (the repo root). All work happens in the worktree from Task 1.

---

## Wave 1 — Scaffolding (one agent, sequential)

Complete every Wave 1 task in order. Do not dispatch Wave 2 until Wave 1 is merged-ready.

---

### Task 1: Create the worktree

**Files:**
- None created yet; worktree directory: `.worktrees/upload-config-redesign/`

- [ ] **Step 1: Create git worktree**

Run from repo root:
```bash
git worktree add .worktrees/upload-config-redesign -b feature/upload-config-redesign
```

Expected: `Preparing worktree (new branch 'feature/upload-config-redesign')`.

- [ ] **Step 2: Change directory to worktree**

All subsequent commands in this plan run from the worktree:
```bash
cd .worktrees/upload-config-redesign
```

- [ ] **Step 3: Sanity check**

Run: `git branch --show-current`
Expected: `feature/upload-config-redesign`

---

### Task 2: Shared primitives

**Files:**
- Create: `src/components/upload-config/primitives/Eyebrow.jsx`
- Create: `src/components/upload-config/primitives/PageTitle.jsx`
- Create: `src/components/upload-config/primitives/CheckPill.jsx`
- Create: `src/components/upload-config/primitives/RadioTile.jsx`
- Create: `src/components/upload-config/primitives/FieldCard.jsx`
- Create: `src/components/upload-config/primitives/Toggle.jsx`

Reference: `~/Downloads/Adpunk/components.jsx` defines all six in inline styles; each file below is the Tailwind port.

- [ ] **Step 1: Write Eyebrow.jsx**

```jsx
// src/components/upload-config/primitives/Eyebrow.jsx
export default function Eyebrow({ icon, tone = 'secondary', children }) {
  const color =
    tone === 'primary' ? 'text-lime'
    : tone === 'tertiary' ? 'text-teal'
    : 'text-purple-accent'

  return (
    <div className={`flex items-center gap-2 ${color}`}>
      {icon && (
        <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>
          {icon}
        </span>
      )}
      <span className="text-[10px] font-bold uppercase tracking-[0.2em] font-['Inter']">
        {children}
      </span>
    </div>
  )
}
```

- [ ] **Step 2: Write PageTitle.jsx**

```jsx
// src/components/upload-config/primitives/PageTitle.jsx
export default function PageTitle({ line1, line2, accentTone = 'primary', size = 26 }) {
  const color =
    accentTone === 'primary' ? 'text-lime'
    : accentTone === 'tertiary' ? 'text-teal'
    : 'text-purple-accent'

  return (
    <h1
      className="font-bold tracking-tight text-on-surface m-0 leading-[1.15] font-['Inter']"
      style={{ fontSize: size }}
    >
      {line1}
      {line2 ? <> <span className={color}>{line2}</span></> : null}
    </h1>
  )
}
```

- [ ] **Step 3: Write CheckPill.jsx**

```jsx
// src/components/upload-config/primitives/CheckPill.jsx
import { useState } from 'react'

export default function CheckPill({ label, icon, checked, onChange, tone = 'primary' }) {
  const [hover, setHover] = useState(false)

  const accentClass =
    tone === 'primary' ? 'text-lime'
    : tone === 'tertiary' ? 'text-teal'
    : 'text-purple-accent'

  const ringClass =
    tone === 'primary' ? 'ring-lime shadow-[0_0_14px_rgba(206,252,0,0.18)]'
    : tone === 'tertiary' ? 'ring-teal shadow-[0_0_14px_rgba(45,212,191,0.18)]'
    : 'ring-purple-accent shadow-[0_0_14px_rgba(193,128,255,0.18)]'

  const bgChecked =
    tone === 'primary' ? 'bg-lime/10'
    : tone === 'tertiary' ? 'bg-teal/10'
    : 'bg-purple-accent/10'

  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'inline-flex items-center gap-2 px-4 py-2.5 rounded-full font-['Inter']',
        'text-[11px] font-bold uppercase tracking-[0.12em] transition-all',
        'cursor-pointer border-none',
        checked
          ? `${bgChecked} ${accentClass} ring-[1.5px] ring-inset ${ringClass}`
          : hover
            ? 'bg-surface-container-highest text-on-surface ring-1 ring-inset ring-border-subtle/15'
            : 'bg-surface-container-low text-on-surface ring-1 ring-inset ring-border-subtle/15',
      ].join(' ')}
    >
      {icon && (
        <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: `"FILL" ${checked ? 1 : 0}` }}>
          {icon}
        </span>
      )}
      {label}
      {checked && (
        <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: '"wght" 700' }}>
          check
        </span>
      )}
    </button>
  )
}
```

- [ ] **Step 4: Write RadioTile.jsx**

```jsx
// src/components/upload-config/primitives/RadioTile.jsx
import { useState } from 'react'

export default function RadioTile({ active, onClick, tone = 'primary', children, className = '' }) {
  const [hover, setHover] = useState(false)

  const ringClass =
    tone === 'primary' ? 'ring-lime shadow-[0_0_24px_rgba(206,252,0,0.10)]'
    : tone === 'tertiary' ? 'ring-teal shadow-[0_0_24px_rgba(45,212,191,0.10)]'
    : 'ring-purple-accent shadow-[0_0_24px_rgba(193,128,255,0.10)]'

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'rounded-xl p-5 cursor-pointer relative transition-all',
        active
          ? `bg-surface-container-high ring-[1.5px] ring-inset ${ringClass}`
          : hover
            ? 'bg-surface-container-highest ring-1 ring-inset ring-border-subtle/10'
            : 'bg-surface-container-low ring-1 ring-inset ring-border-subtle/10',
        className,
      ].join(' ')}
    >
      {children}
    </div>
  )
}
```

- [ ] **Step 5: Write FieldCard.jsx**

```jsx
// src/components/upload-config/primitives/FieldCard.jsx
export default function FieldCard({ label, hint, icon, children }) {
  return (
    <div className="bg-surface-container-low rounded-xl p-[18px] ring-1 ring-inset ring-border-subtle/8">
      <div className="flex items-center gap-2.5 mb-3.5">
        {icon && (
          <div className="w-7 h-7 rounded-md bg-surface-container-high text-on-surface-variant flex items-center justify-center">
            <span className="material-symbols-outlined text-[16px]">{icon}</span>
          </div>
        )}
        <div className="flex-1">
          <div className="text-[10px] font-extrabold text-on-surface tracking-[0.2em] uppercase font-['Inter']">
            {label}
          </div>
          {hint && <div className="text-[10px] text-muted mt-[3px] font-['Inter']">{hint}</div>}
        </div>
      </div>
      {children}
    </div>
  )
}
```

- [ ] **Step 6: Write Toggle.jsx**

```jsx
// src/components/upload-config/primitives/Toggle.jsx
export default function Toggle({ checked, onChange, tone = 'primary' }) {
  const bgClass = checked
    ? (tone === 'primary' ? 'bg-lime'
      : tone === 'tertiary' ? 'bg-teal'
      : 'bg-purple-accent')
    : 'bg-surface-container-high'

  const glow = checked
    ? (tone === 'primary' ? 'shadow-[0_0_12px_rgba(206,252,0,0.4)]'
      : tone === 'tertiary' ? 'shadow-[0_0_12px_rgba(45,212,191,0.4)]'
      : 'shadow-[0_0_12px_rgba(193,128,255,0.4)]')
    : ''

  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-[22px] rounded-full border-none p-0 cursor-pointer transition-colors shrink-0 ${bgClass} ${glow}`}
    >
      <div
        className={`absolute top-[3px] w-4 h-4 rounded-full transition-[left] ${checked ? 'bg-on-surface' : 'bg-on-surface'}`}
        style={{ left: checked ? 21 : 3 }}
      />
    </button>
  )
}
```

- [ ] **Step 7: Commit**

```bash
git add src/components/upload-config/primitives/
git commit -m "feat(upload-config): shared UI primitives for new upload flow"
```

---

### Task 3: Stepper component

**Files:**
- Create: `src/components/upload-config/Stepper.jsx`

Reference: `~/Downloads/Adpunk/stepper.jsx`.

- [ ] **Step 1: Write Stepper.jsx**

```jsx
// src/components/upload-config/Stepper.jsx
import { Fragment } from 'react'

export default function Stepper({ steps, current, onJump }) {
  return (
    <div className="flex items-center gap-1">
      {steps.map((s, i) => {
        const done = i < current
        const active = i === current
        const canJump = done

        return (
          <Fragment key={s.id}>
            <div
              onClick={() => canJump && onJump?.(i)}
              className={[
                'flex items-center gap-2 px-2.5 py-1.5 rounded-full transition-all',
                active ? 'bg-lime/10' : 'bg-transparent',
                canJump ? 'cursor-pointer' : 'cursor-default',
              ].join(' ')}
            >
              <div
                className={[
                  'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-extrabold font-["Inter"] transition-all',
                  active ? 'bg-lime text-on-primary-container shadow-[0_0_12px_rgba(206,252,0,0.45)]'
                    : done ? 'bg-lime/25 text-lime'
                    : 'bg-surface-container-high text-muted',
                ].join(' ')}
              >
                {done ? (
                  <span className="material-symbols-outlined text-[12px]" style={{ fontVariationSettings: '"wght" 700' }}>
                    check
                  </span>
                ) : (
                  i + 1
                )}
              </div>
              <span
                className={[
                  'text-[10px] font-bold uppercase tracking-[0.2em] font-["Inter"]',
                  active ? 'text-lime' : done ? 'text-on-surface-variant' : 'text-muted/60',
                ].join(' ')}
              >
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={[
                  'w-5 h-px',
                  done ? 'bg-lime/25' : 'bg-border-subtle/25',
                ].join(' ')}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/upload-config/Stepper.jsx
git commit -m "feat(upload-config): stepper header"
```

---

### Task 4: Schema migration — PostgreSQL + SQLite + init-time ALTER

**Files:**
- Modify: `server/schema-pg.sql:4-21` (add four columns inline to `video_groups`)
- Modify: `server/schema.sql:3-7` (add four columns inline to `video_groups`)
- Modify: `server/db.js:45-48` (add idempotent ALTER statements for existing databases)

- [ ] **Step 1: Add columns to `schema-pg.sql`**

Open `server/schema-pg.sql`. Find the `video_groups` table (starts at line 4). Replace it so the complete definition includes the four new columns:

```sql
CREATE TABLE IF NOT EXISTS video_groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  assembly_status TEXT,
  assembly_error TEXT,
  assembled_transcript TEXT,
  assembly_details_json TEXT,
  upload_batch_id TEXT,
  timeline_json TEXT,
  rough_cut_config_json TEXT,
  sync_mode TEXT,
  editor_state_json TEXT,
  classification_json TEXT,
  parent_group_id INTEGER REFERENCES video_groups(id),
  annotations_json TEXT,
  user_id TEXT,
  libraries_json TEXT,
  freepik_opt_in BOOLEAN DEFAULT TRUE,
  audience_json TEXT,
  path_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

- [ ] **Step 2: Add columns to `schema.sql`**

Open `server/schema.sql`. Find `CREATE TABLE IF NOT EXISTS video_groups` (line 3). Replace with:

```sql
CREATE TABLE IF NOT EXISTS video_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  libraries_json TEXT,
  freepik_opt_in INTEGER DEFAULT 1,
  audience_json TEXT,
  path_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

(SQLite uses `INTEGER` for booleans; existing SQLite databases don't use most of the Postgres columns anyway.)

- [ ] **Step 3: Add idempotent ALTERs to `server/db.js`**

Open `server/db.js`. Around line 46–48 there's an existing block of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements. Add these four after the existing ones, inside the same `try/catch` (Postgres path):

```js
await pool.query(`ALTER TABLE video_groups ADD COLUMN IF NOT EXISTS libraries_json TEXT`)
await pool.query(`ALTER TABLE video_groups ADD COLUMN IF NOT EXISTS freepik_opt_in BOOLEAN DEFAULT TRUE`)
await pool.query(`ALTER TABLE video_groups ADD COLUMN IF NOT EXISTS audience_json TEXT`)
await pool.query(`ALTER TABLE video_groups ADD COLUMN IF NOT EXISTS path_id TEXT`)
```

If the SQLite init path also runs ALTER statements elsewhere in `server/db.js`, mirror the same four columns using SQLite syntax (`ALTER TABLE ... ADD COLUMN`, no `IF NOT EXISTS` — wrap each in its own try/catch). Read the file first to determine if this path exists.

- [ ] **Step 4: Start server and confirm schema applies**

```bash
npm run dev:server
```

Watch the console for schema errors. Kill once "Server listening" appears.

- [ ] **Step 5: Commit**

```bash
git add server/schema-pg.sql server/schema.sql server/db.js
git commit -m "feat(upload-config): video_groups columns for libraries/audience/path"
```

---

### Task 5: Backend API extension + default rough-cut config

**Files:**
- Modify: `server/routes/videos.js:2236-2253` (extend `POST /groups` + `PUT /groups/:id`)
- Modify: `server/routes/videos.js:488-495` (extend `GET /groups/:id` response shape, and the `GET /videos` response if relevant)
- Create: `server/routes/__tests__/videos-groups.test.js`

- [ ] **Step 1: Locate the existing POST and PUT handlers**

Read `server/routes/videos.js` lines 2230–2260. Confirm current shape of `POST /groups` and `PUT /groups/:id`.

- [ ] **Step 2: Add DEFAULT_ROUGH_CUT_CONFIG constant**

At the top of `server/routes/videos.js` (near other constants — look for `const API_BASE` or similar), add:

```js
const DEFAULT_ROUGH_CUT_CONFIG = {
  cut: { silences: true, false_starts: false, filler_words: true, meta_commentary: false },
  identify: { repetition: true, lengthy: false, technical_unclear: false, irrelevance: false },
}
```

(Matches the constant in the soon-to-be-deleted `RoughCutConfigModal.jsx:5-8`.)

- [ ] **Step 3: Update POST /groups to backfill rough_cut_config_json**

Replace the existing `POST /groups` handler:

```js
router.post('/groups', requireAuth, async (req, res) => {
  const { name } = req.body
  if (!name) return res.status(400).json({ error: 'Name is required' })
  const result = await db.prepare(
    'INSERT INTO video_groups (name, user_id, rough_cut_config_json) VALUES (?, ?, ?)'
  ).run(name, req.auth.userId, JSON.stringify(DEFAULT_ROUGH_CUT_CONFIG))
  const group = await db.prepare('SELECT * FROM video_groups WHERE id = ?').get(result.lastInsertRowid)
  res.status(201).json(group)
})
```

- [ ] **Step 4: Update PUT /groups/:id to accept new fields**

Replace the existing `PUT /groups/:id` handler:

```js
router.put('/groups/:id', requireAuth, async (req, res) => {
  const { rough_cut_config_json, libraries, freepik_opt_in, audience, path_id } = req.body

  const group = await db.prepare(
    `SELECT * FROM video_groups WHERE id = ? ${isAdmin(req) ? '' : 'AND user_id = ?'}`
  ).get(req.params.id, ...(isAdmin(req) ? [] : [req.auth.userId]))
  if (!group) return res.status(404).json({ error: 'Group not found' })

  const updates = []
  const values = []

  if (rough_cut_config_json !== undefined) {
    updates.push('rough_cut_config_json = ?')
    values.push(JSON.stringify(rough_cut_config_json))
  }

  if (libraries !== undefined) {
    const VALID_LIBS = ['envato', 'artlist', 'storyblocks']
    if (!Array.isArray(libraries) || libraries.some(l => !VALID_LIBS.includes(l))) {
      return res.status(400).json({ error: 'libraries must be an array of: ' + VALID_LIBS.join(', ') })
    }
    updates.push('libraries_json = ?')
    values.push(JSON.stringify(libraries))
  }

  if (freepik_opt_in !== undefined) {
    if (typeof freepik_opt_in !== 'boolean') {
      return res.status(400).json({ error: 'freepik_opt_in must be boolean' })
    }
    updates.push('freepik_opt_in = ?')
    values.push(freepik_opt_in)
  }

  if (audience !== undefined) {
    if (typeof audience !== 'object' || audience === null) {
      return res.status(400).json({ error: 'audience must be an object' })
    }
    updates.push('audience_json = ?')
    values.push(JSON.stringify(audience))
  }

  if (path_id !== undefined) {
    const VALID_PATHS = ['hands-off', 'strategy-only', 'guided']
    if (!VALID_PATHS.includes(path_id)) {
      return res.status(400).json({ error: 'path_id must be one of: ' + VALID_PATHS.join(', ') })
    }
    updates.push('path_id = ?')
    values.push(path_id)
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' })
  }

  values.push(req.params.id)
  await db.prepare(`UPDATE video_groups SET ${updates.join(', ')} WHERE id = ?`).run(...values)
  const updated = await db.prepare('SELECT * FROM video_groups WHERE id = ?').get(req.params.id)
  res.json(updated)
})
```

- [ ] **Step 5: Extend GET response to parse new JSON fields**

Read `server/routes/videos.js:488-500` to find the GET response shape that returns group fields. Look for `rough_cut_config: group.rough_cut_config_json ? JSON.parse(...)` pattern. Immediately after that line, add:

```js
libraries: group.libraries_json ? JSON.parse(group.libraries_json) : [],
freepik_opt_in: group.freepik_opt_in === null || group.freepik_opt_in === undefined ? true : !!group.freepik_opt_in,
audience: group.audience_json ? JSON.parse(group.audience_json) : null,
path_id: group.path_id || null,
```

If there's another handler (e.g., `GET /videos` or `GET /groups/:id`) that also returns groups, mirror the same enrichment there. Grep for `rough_cut_config_json` to find all call sites.

- [ ] **Step 6: Write a test for PUT validation**

Create `server/routes/__tests__/videos-groups.test.js`:

```js
// server/routes/__tests__/videos-groups.test.js
// Unit tests for the validation logic in PUT /videos/groups/:id.
// We export a pure validator helper and test it directly — the full
// route is integration-tested by manual smoke for now.
import { describe, it, expect } from 'vitest'
import { validateGroupUpdate } from '../videos.js'

describe('validateGroupUpdate', () => {
  it('accepts valid libraries', () => {
    const { error } = validateGroupUpdate({ libraries: ['envato', 'artlist'] })
    expect(error).toBeNull()
  })

  it('rejects unknown library', () => {
    const { error } = validateGroupUpdate({ libraries: ['envato', 'unknown'] })
    expect(error).toMatch(/libraries must be/)
  })

  it('rejects non-array libraries', () => {
    const { error } = validateGroupUpdate({ libraries: 'envato' })
    expect(error).toMatch(/libraries must be/)
  })

  it('accepts valid path_id', () => {
    const { error } = validateGroupUpdate({ path_id: 'hands-off' })
    expect(error).toBeNull()
  })

  it('rejects invalid path_id', () => {
    const { error } = validateGroupUpdate({ path_id: 'invalid-path' })
    expect(error).toMatch(/path_id must be/)
  })

  it('accepts boolean freepik_opt_in', () => {
    const { error } = validateGroupUpdate({ freepik_opt_in: true })
    expect(error).toBeNull()
  })

  it('rejects non-boolean freepik_opt_in', () => {
    const { error } = validateGroupUpdate({ freepik_opt_in: 'yes' })
    expect(error).toMatch(/freepik_opt_in must be boolean/)
  })

  it('accepts audience object', () => {
    const { error } = validateGroupUpdate({ audience: { age: ['gen_z'] } })
    expect(error).toBeNull()
  })

  it('rejects non-object audience', () => {
    const { error } = validateGroupUpdate({ audience: 'some string' })
    expect(error).toMatch(/audience must be/)
  })
})
```

- [ ] **Step 7: Extract and export `validateGroupUpdate`**

Refactor the validation logic out of the PUT handler and export it. In `server/routes/videos.js`, before the PUT handler (or anywhere before `export default router`), add:

```js
export function validateGroupUpdate(body) {
  const VALID_LIBS = ['envato', 'artlist', 'storyblocks']
  const VALID_PATHS = ['hands-off', 'strategy-only', 'guided']

  if (body.libraries !== undefined) {
    if (!Array.isArray(body.libraries) || body.libraries.some(l => !VALID_LIBS.includes(l))) {
      return { error: 'libraries must be an array of: ' + VALID_LIBS.join(', ') }
    }
  }
  if (body.freepik_opt_in !== undefined && typeof body.freepik_opt_in !== 'boolean') {
    return { error: 'freepik_opt_in must be boolean' }
  }
  if (body.audience !== undefined && (typeof body.audience !== 'object' || body.audience === null)) {
    return { error: 'audience must be an object' }
  }
  if (body.path_id !== undefined && !VALID_PATHS.includes(body.path_id)) {
    return { error: 'path_id must be one of: ' + VALID_PATHS.join(', ') }
  }
  return { error: null }
}
```

Then update the PUT handler to call it first:
```js
const validation = validateGroupUpdate(req.body)
if (validation.error) return res.status(400).json({ error: validation.error })
```
And remove the now-duplicated inline checks from the earlier step's handler.

- [ ] **Step 8: Run the test**

```bash
npm run test -- server/routes/__tests__/videos-groups.test.js
```

Expected: 9 passing.

- [ ] **Step 9: Commit**

```bash
git add server/routes/videos.js server/routes/__tests__/videos-groups.test.js
git commit -m "feat(upload-config): PUT /videos/groups/:id accepts libraries/audience/path + POST writes default rough-cut config"
```

---

### Task 6: Placeholder step files

**Files:**
- Create: `src/components/upload-config/steps/StepLibraries.jsx`
- Create: `src/components/upload-config/steps/StepAudience.jsx`
- Create: `src/components/upload-config/steps/StepReferences.jsx`
- Create: `src/components/upload-config/steps/StepPath.jsx`
- Create: `src/components/upload-config/steps/StepDone.jsx`

Purpose: give the orchestrator something to import. Wave 2 agents replace these bodies.

- [ ] **Step 1: Write all five placeholders**

Each file:
```jsx
// src/components/upload-config/steps/StepLibraries.jsx
export default function StepLibraries(/* { state, setState } */) {
  return <div className="text-muted p-6">StepLibraries placeholder</div>
}
```

Repeat verbatim for `StepAudience.jsx`, `StepReferences.jsx`, `StepPath.jsx`, `StepDone.jsx` — each exports a function with the step's name.

- [ ] **Step 2: Commit**

```bash
git add src/components/upload-config/steps/
git commit -m "feat(upload-config): placeholder step components"
```

---

### Task 7: UploadConfigFlow orchestrator

**Files:**
- Create: `src/components/upload-config/UploadConfigFlow.jsx`

Reference: `~/Downloads/Adpunk/Upload Configuration.html` lines 143–267 (orchestrator logic).

- [ ] **Step 1: Write the orchestrator**

```jsx
// src/components/upload-config/UploadConfigFlow.jsx
import { useEffect, useReducer } from 'react'
import { apiPut } from '../../hooks/useApi.js'
import Stepper from './Stepper.jsx'
import StepLibraries from './steps/StepLibraries.jsx'
import StepAudience from './steps/StepAudience.jsx'
import StepReferences from './steps/StepReferences.jsx'
import StepPath from './steps/StepPath.jsx'
import StepDone from './steps/StepDone.jsx'

// Full unified journey — header always shows upload + transcribe framing.
const UNIFIED_STEPS = [
  { id: 'upload',     label: 'Upload' },
  { id: 'libraries',  label: 'Libraries' },
  { id: 'audience',   label: 'Audience' },
  { id: 'references', label: 'Refs' },
  { id: 'path',       label: 'Path' },
  { id: 'transcribe', label: 'Transcribe' },
]
// Config flow drives steps 1–4 of the unified list.
const CONFIG_STEPS = UNIFIED_STEPS.slice(1, 5)
const UNIFIED_OFFSET = 1

const DEFAULT_STATE = {
  libraries: [],
  freepikOptIn: true,
  audience: {
    age: ['millennial', 'gen_z'],
    sex: ['any'],
    ethnicity: ['any'],
    language: 'English',
    region: '',
    notes: '',
  },
  pathId: 'strategy-only',
}

function reducer(state, action) {
  switch (action.type) {
    case 'hydrate':      return { ...state, ...action.payload }
    case 'setLibraries': return { ...state, libraries: action.payload }
    case 'setFreepikOptIn': return { ...state, freepikOptIn: action.payload }
    case 'setAudience':  return { ...state, audience: action.payload }
    case 'setPathId':    return { ...state, pathId: action.payload }
    default: return state
  }
}

export default function UploadConfigFlow({ groupId, initialState, onBack, onComplete }) {
  const [current, setCurrent] = useReducerStep(0)
  const [submitted, setSubmitted] = useReducerStep(false)
  const [state, dispatch] = useReducer(reducer, { ...DEFAULT_STATE, ...(initialState || {}) })

  // Hydrate from DB on mount (initialState may already have it; this is a safety net)
  useEffect(() => {
    if (initialState) dispatch({ type: 'hydrate', payload: initialState })
  }, [initialState])

  // Persist on step-forward
  async function persistCurrent() {
    const stepId = CONFIG_STEPS[current].id
    const body = {}
    if (stepId === 'libraries') {
      body.libraries = state.libraries
      body.freepik_opt_in = state.freepikOptIn
    } else if (stepId === 'audience') {
      body.audience = state.audience
    } else if (stepId === 'path') {
      body.path_id = state.pathId
    }
    // references has no batched persistence — it hits its own API per-add
    if (Object.keys(body).length) {
      await apiPut(`/videos/groups/${groupId}`, body)
    }
  }

  const next = async () => {
    await persistCurrent()
    if (current < CONFIG_STEPS.length - 1) setCurrent(current + 1)
    else setSubmitted(true)
  }
  const back = () => {
    if (submitted) setSubmitted(false)
    else if (current > 0) setCurrent(current - 1)
    else onBack?.()
  }

  const isLast = current === CONFIG_STEPS.length - 1

  const setState = {
    libraries: v => dispatch({ type: 'setLibraries', payload: v }),
    freepikOptIn: v => dispatch({ type: 'setFreepikOptIn', payload: v }),
    audience: v => dispatch({ type: 'setAudience', payload: v }),
    pathId: v => dispatch({ type: 'setPathId', payload: v }),
  }

  let body
  if (submitted) body = <StepDone state={state} onEdit={() => setSubmitted(false)} onComplete={onComplete} />
  else if (current === 0) body = <StepLibraries state={state} setState={setState} />
  else if (current === 1) body = <StepAudience state={state} setState={setState} />
  else if (current === 2) body = <StepReferences groupId={groupId} />
  else if (current === 3) body = <StepPath state={state} setState={setState} />

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-md p-6">
      <div className="w-full max-w-[1120px] max-h-[calc(100vh-48px)] bg-surface-container-low/95 backdrop-blur-2xl rounded-2xl overflow-hidden flex flex-col ring-1 ring-inset ring-white/4 shadow-[0_0_80px_rgba(0,0,0,0.8)]">
        {/* Header */}
        <div className="px-8 py-5 shrink-0 ring-[0.5px] ring-inset ring-white/4 flex items-center justify-between gap-6">
          <Stepper
            steps={UNIFIED_STEPS}
            current={submitted ? UNIFIED_OFFSET + CONFIG_STEPS.length : UNIFIED_OFFSET + current}
            onJump={i => {
              if (i === 0) { onBack?.(); return }
              if (i >= UNIFIED_OFFSET && i < UNIFIED_OFFSET + CONFIG_STEPS.length) {
                setSubmitted(false)
                setCurrent(i - UNIFIED_OFFSET)
              }
            }}
          />
        </div>

        {/* Body */}
        <div className="px-10 py-8 overflow-y-auto flex-1">
          {body}
        </div>

        {/* Footer */}
        {!submitted && (
          <div className="px-8 py-5 bg-surface-container-low/90 backdrop-blur-sm ring-[0.5px] ring-inset ring-white/4 flex items-center justify-between gap-5 shrink-0">
            <button
              onClick={back}
              className="text-on-surface-variant font-bold uppercase tracking-widest text-xs hover:text-on-surface transition-colors px-4 py-2"
            >
              {current === 0 ? 'Back to Upload' : 'Back'}
            </button>
            <div className="flex items-center gap-6">
              <div className="flex flex-col items-end">
                <span className={`text-[10px] font-extrabold uppercase tracking-[0.2em] font-['Inter'] ${isLast ? 'text-lime' : 'text-on-surface-variant'}`}>
                  {isLast ? 'Ready For Calibration' : `Step ${UNIFIED_OFFSET + current + 1} of ${UNIFIED_STEPS.length}`}
                </span>
                <span className="text-[11px] text-muted mt-0.5 font-['Inter']">
                  {isLast ? 'Est. analysis · 2m 45s' : `Next: ${CONFIG_STEPS[current + 1]?.label || ''}`}
                </span>
              </div>
              <button
                onClick={next}
                className="bg-gradient-to-br from-lime to-primary-dim text-on-primary-container font-extrabold text-xs uppercase tracking-[0.15em] px-8 py-4 rounded-md shadow-[0_0_32px_rgba(206,252,0,0.25)] hover:shadow-[0_0_48px_rgba(206,252,0,0.45)] active:scale-95 transition-all"
              >
                {isLast ? 'Review & Continue' : 'Continue'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Tiny useState wrapper that lets reducers be named descriptively without ceremony.
function useReducerStep(init) {
  const [v, set] = useReducer((_, next) => next, init)
  return [v, set]
}
```

- [ ] **Step 2: Verify typecheck (Vite build)**

```bash
npx vite build --mode development
```

Expected: no errors. If Vite complains about JSX imports, check each file has a default export.

- [ ] **Step 3: Commit**

```bash
git add src/components/upload-config/UploadConfigFlow.jsx
git commit -m "feat(upload-config): flow orchestrator with placeholder steps"
```

---

### Task 8: Wire into ProjectsView + legacy redirect + delete RoughCutConfigModal

**Files:**
- Modify: `src/components/views/ProjectsView.jsx:1-308`
- Delete: `src/components/views/RoughCutConfigModal.jsx`

- [ ] **Step 1: Read existing ProjectsView wiring**

Open `src/components/views/ProjectsView.jsx`. Note:
- Line 6: `import RoughCutConfigModal from './RoughCutConfigModal.jsx'`
- Line 22: `const step = searchParams.get('step')`
- Line 271: modal switch

- [ ] **Step 2: Update imports**

Replace line 6:
```jsx
import UploadConfigFlow from '../upload-config/UploadConfigFlow.jsx'
```

- [ ] **Step 3: Add step-mapping constants**

After the `tabs` constant at the top of the file (line 10):
```jsx
const CONFIG_STEPS = new Set(['libraries', 'audience', 'references', 'path'])
```

- [ ] **Step 4: Add legacy `step=config` redirect**

Directly inside the component body, after `const step = searchParams.get('step')` (around line 22), add:
```jsx
useEffect(() => {
  if (step === 'config') {
    setSearchParams(
      groupId ? { step: 'libraries', group: String(groupId) } : {},
      { replace: true }
    )
  }
  // Also redirect old 'broll-examples' → 'references' (same step, renamed)
  if (step === 'broll-examples') {
    setSearchParams(
      { step: 'references', ...(groupId ? { group: String(groupId) } : {}) },
      { replace: true }
    )
  }
}, [step, groupId, setSearchParams])
```

And add `useEffect` to the React import at the top:
```jsx
import { useState, useRef, useCallback, useEffect } from 'react'
```

- [ ] **Step 5: Replace the modal switch**

Replace lines 271–305 (the `{(step === 'upload' ...)}` block and everything after it through the closing `</div>`) with:

```jsx
{step === 'upload' && (
  <UploadModal
    onClose={() => setStep(null)}
    onComplete={(gid, files) => setStep('libraries', gid, files)}
    initialGroupId={groupId}
    onFilesChange={(f) => { filesRef.current = f; setLiveFiles(f) }}
  />
)}

{CONFIG_STEPS.has(step) && (
  <UploadConfigFlow
    groupId={groupId}
    initialState={null /* TODO: hydrate from videos list entry for this group */}
    onBack={() => setStep('upload', groupId)}
    onComplete={(gid) => setStep('processing', gid)}
  />
)}

{step === 'processing' && (
  <ProcessingModal
    groupId={groupId}
    initialFiles={filesRef.current}
    liveFiles={liveFiles}
    onBack={() => setStep('path', groupId)}
    onComplete={(gid) => {
      setStep(null); refetch(); navigate(`/editor/${gid}/assets`)
    }}
  />
)}
```

Note: The `UploadConfigFlow` component currently routes internally by its own step counter, not by the URL. A follow-up task (out of scope this iteration) can thread URL step → internal step so the browser back button works step-by-step. For now, clicking Back on step 1 of the flow returns to upload.

- [ ] **Step 6: Remove RoughCutConfigModal import and file**

Remove line 6 (the old import — already done in Step 2) and remove the reference to `RoughCutConfigModal` from the JSX (already done in Step 5). Then:

```bash
rm src/components/views/RoughCutConfigModal.jsx
```

Also delete this line from `ProjectsView.jsx` if it wasn't already replaced:
```jsx
// remove any remaining `import RoughCutConfigModal ...` lines
```

- [ ] **Step 7: Hydrate `initialState` from the group's current DB row**

Locate in the existing code where videos (and their groups) are loaded — `useApi('/videos')` at line 13. Find the current group inside `projects`:

Add after the `projects` `const` definition (around line 77):
```jsx
const currentGroup = projects.find(p => p.id === groupId) || null
const initialConfig = currentGroup ? {
  libraries: currentGroup.libraries || [],
  freepikOptIn: currentGroup.freepik_opt_in !== false,
  audience: currentGroup.audience || undefined, // undefined → reducer uses DEFAULT
  pathId: currentGroup.path_id || undefined,
} : null
```

Then pass it into `UploadConfigFlow`:
```jsx
initialState={initialConfig}
```

(Replace the placeholder `null /* TODO... */` from Step 5.)

NOTE: This pulls group data from the list `GET /videos` response, which currently returns per-video rows with group fields flattened. Verify the group fields (`libraries`, `audience`, etc.) are included by Task 5's backend changes. If the list endpoint doesn't expose them, extend the SELECT in `GET /videos` accordingly.

- [ ] **Step 8: Visual smoke test**

```bash
npm run dev
```

In the browser:
1. Open the app, create a new project (upload at least one video).
2. After upload completes, verify URL is `?step=libraries&group=N`.
3. Click Continue through the 4 steps — each shows its placeholder text.
4. On step 4 (Path), Continue should land on the "Done" step placeholder.
5. Click "Proceed to Editor" (if StepDone stub has one) or use the Next button.
6. Verify a `?step=config&group=N` URL redirects to `?step=libraries&group=N`.

Record any errors.

- [ ] **Step 9: Commit**

```bash
git add src/components/views/ProjectsView.jsx
git rm src/components/views/RoughCutConfigModal.jsx
git commit -m "feat(upload-config): wire UploadConfigFlow into ProjectsView, remove RoughCutConfigModal"
```

---

### Task 9: Wave 1 handoff sanity check

- [ ] **Step 1: Run full test suite**

```bash
npm run test
```

Expected: all existing tests + the 9 new validateGroupUpdate tests pass.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Vite build finishes with no errors.

- [ ] **Step 3: Record Wave 1 completion**

```bash
git log --oneline -10
```

Expected: 6 commits on `feature/upload-config-redesign` covering primitives, stepper, schema, API, placeholders, orchestrator, ProjectsView wiring.

Wave 1 complete. Wave 2 agents can now dispatch in parallel.

---

## Wave 2 — Step implementations (four agents, parallel)

Each agent works against the Wave 1 worktree state. Agents A/B/D touch disjoint files and can commit independently; Agent C deletes `BRollExamplesModal.jsx` (no other owner) and rewrites `StepReferences.jsx`. Agent D also touches `server/routes/broll.js` and `src/components/editor/BRollEditor.jsx` — not touched by any other agent.

When all four have committed, the user (or a reviewer) inspects the worktree diff and opens a PR against main.

---

### Task 10: Agent A — StepLibraries

**Files:**
- Modify: `src/components/upload-config/steps/StepLibraries.jsx` (replace placeholder)

Reference: `~/Downloads/Adpunk/step-libraries.jsx` (full design; port inline styles to Tailwind using conventions from Task 2 primitives).

- [ ] **Step 1: Read the design reference**

Open `~/Downloads/Adpunk/step-libraries.jsx`. Take note of:
- Three library tiles (Envato, Artlist, Storyblocks) with inline SVG logos (lines 11–54).
- `LibraryTile` component structure (lines 65–112).
- "I don't own any" fallback card with Freepik toggle (lines 141–204).
- Summary line showing active libraries (lines 207–224).

- [ ] **Step 2: Implement StepLibraries**

Replace the entire contents of `src/components/upload-config/steps/StepLibraries.jsx` with:

```jsx
// src/components/upload-config/steps/StepLibraries.jsx
import { useState } from 'react'
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'
import Toggle from '../primitives/Toggle.jsx'

const LIBRARIES = [
  { id: 'envato',      name: 'Envato',      tagline: 'Elements · premium footage',   stats: '12M+ assets' },
  { id: 'artlist',     name: 'Artlist',     tagline: 'Cinematic footage & music',    stats: '2M+ clips' },
  { id: 'storyblocks', name: 'Storyblocks', tagline: 'Unlimited stock subscription', stats: '1M+ clips' },
]

function LibraryTile({ lib, checked, onToggle }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      onClick={() => onToggle(lib.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'rounded-xl p-5 cursor-pointer transition-all flex flex-col gap-3.5 min-h-[150px] relative',
        checked
          ? 'bg-surface-container-high ring-[1.5px] ring-inset ring-lime shadow-[0_0_24px_rgba(206,252,0,0.08)]'
          : hover
            ? 'bg-surface-container-highest ring-1 ring-inset ring-border-subtle/10'
            : 'bg-surface-container-low ring-1 ring-inset ring-border-subtle/10',
      ].join(' ')}
    >
      <div className="flex justify-between items-start">
        <div className="h-9 flex items-center px-2.5 py-1.5 rounded bg-black/25">
          <span className="text-sm font-extrabold text-on-surface font-['Inter']">{lib.name}</span>
        </div>
        <div className={[
          'w-[22px] h-[22px] rounded-full flex items-center justify-center',
          checked ? 'bg-lime text-on-primary-container shadow-[0_0_10px_rgba(206,252,0,0.4)]'
            : 'bg-transparent text-muted ring-1 ring-border-subtle/40',
        ].join(' ')}>
          <span className="material-symbols-outlined text-[13px]" style={{ fontVariationSettings: '"wght" 700' }}>
            {checked ? 'check' : 'add'}
          </span>
        </div>
      </div>
      <div className="text-xs text-on-surface-variant font-['Inter'] leading-[1.4]">
        {lib.tagline}
      </div>
      <div className="mt-auto">
        <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-surface-container-high text-on-surface-variant text-[10px] font-bold tracking-[0.15em] uppercase font-['Inter'] ring-1 ring-inset ring-border-subtle/15">
          {lib.stats}
        </span>
      </div>
    </div>
  )
}

export default function StepLibraries({ state, setState }) {
  const selected = state.libraries
  const none = selected.length === 0
  const toggle = id => setState.libraries(
    selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id]
  )
  const clearAll = () => setState.libraries([])

  const sourcesLine = none
    ? `Pexels${state.freepikOptIn ? ' + Freepik (paid, confirm each)' : ' only'}`
    : selected.map(id => LIBRARIES.find(l => l.id === id)?.name).filter(Boolean).join(' · ')

  return (
    <div>
      <div className="mb-7">
        <Eyebrow icon="inventory_2" tone="secondary">B-Roll Sources · Step 2 of 6</Eyebrow>
        <div className="mt-3.5">
          <PageTitle line1="Which stock libraries" line2="do you subscribe to?" accentTone="primary" size={26} />
        </div>
        <p className="mt-3 text-on-surface-variant text-[13px] max-w-[640px] leading-[1.6]">
          Select every subscription you already have a paid seat for. Kinetic will search b-roll across these
          libraries at no extra cost. Select all that apply.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3.5 mb-4">
        {LIBRARIES.map(lib => (
          <LibraryTile
            key={lib.id}
            lib={lib}
            checked={selected.includes(lib.id)}
            onToggle={toggle}
          />
        ))}
      </div>

      <div
        onClick={() => none ? null : clearAll()}
        className={[
          'rounded-xl transition-all',
          none
            ? 'bg-purple-accent/6 p-[22px] ring-[1.5px] ring-inset ring-purple-accent/35 shadow-[0_0_32px_rgba(193,128,255,0.06)] cursor-default'
            : 'bg-surface-container-low p-[18px] ring-1 ring-inset ring-border-subtle/10 cursor-pointer',
        ].join(' ')}
      >
        <div className="flex items-start gap-4">
          <div className={[
            'w-[42px] h-[42px] rounded-[10px] shrink-0 flex items-center justify-center',
            none ? 'bg-purple-accent/15 text-purple-accent' : 'bg-surface-container-high text-on-surface-variant',
          ].join(' ')}>
            <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: `"FILL" ${none ? 1 : 0}` }}>
              public
            </span>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2.5 mb-1">
              <span className="text-[15px] font-bold text-on-surface font-['Inter']">
                I don't own any subscriptions
              </span>
              {none && (
                <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-purple-accent/12 text-purple-accent text-[9px] font-bold tracking-[0.15em] uppercase font-['Inter'] ring-1 ring-inset ring-purple-accent/25">
                  <span className="material-symbols-outlined text-[11px]">bolt</span>
                  Active fallback
                </span>
              )}
            </div>
            <p className="text-xs text-on-surface-variant leading-[1.6] m-0 mt-2 max-w-[680px]">
              We'll use <span className="text-on-surface font-semibold">Pexels</span> (free) wherever possible.
              For moments Pexels can't cover, we can also pull from{' '}
              <span className="text-on-surface font-semibold">Freepik</span> at{' '}
              <span className="font-mono text-lime">$0.05 / clip</span>.{' '}
              <span className="text-on-surface font-semibold">Nothing is charged until you confirm each download.</span>
            </p>

            {none && (
              <div className="mt-4 p-3.5 rounded-[10px] bg-surface-container-highest ring-1 ring-inset ring-border-subtle/12 flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="px-2.5 py-1.5 rounded bg-black/25 flex items-center">
                    <span className="text-sm font-extrabold text-on-surface font-['Inter']">Freepik</span>
                  </div>
                  <div>
                    <div className="text-xs font-bold text-on-surface font-['Inter']">Allow paid Freepik fallback</div>
                    <div className="text-[11px] text-on-surface-variant mt-[3px] font-['Inter']">
                      Surfaces clips for shots Pexels misses — you approve every charge before download.
                    </div>
                  </div>
                </div>
                <Toggle checked={state.freepikOptIn} onChange={setState.freepikOptIn} tone="secondary" />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 px-[18px] py-3.5 rounded-[10px] bg-surface-container-low ring-1 ring-inset ring-border-subtle/8 flex items-center gap-3">
        <span className="material-symbols-outlined text-[18px] text-lime">search</span>
        <div className="text-xs text-on-surface-variant leading-[1.5] font-['Inter']">
          <span className="text-on-surface font-semibold">B-roll will be searched across:</span>{' '}
          {sourcesLine}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify build**

```bash
npx vite build --mode development
```

- [ ] **Step 4: Manual visual check**

Run `npm run dev`, navigate to the Libraries step, confirm the three tiles render, toggling selection works, and the fallback block with Freepik toggle appears when nothing is selected.

- [ ] **Step 5: Commit**

```bash
git add src/components/upload-config/steps/StepLibraries.jsx
git commit -m "feat(upload-config): StepLibraries — subscription tiles + Pexels fallback"
```

---

### Task 11: Agent B — StepAudience

**Files:**
- Modify: `src/components/upload-config/steps/StepAudience.jsx` (replace placeholder)

Reference: `~/Downloads/Adpunk/step-audience.jsx` for field structure + option lists.

- [ ] **Step 1: Read the design reference**

Open `~/Downloads/Adpunk/step-audience.jsx`. Capture:
- `AGE_GROUPS` (6 options), `SEX` (4 options), `ETHNICITY` (9 options), `LANGUAGES` (12 strings) — reuse verbatim.
- Layout: 2-col grid for Age+Sex, full-width Ethnicity, 2-col for Language+Region, full-width Notes.

- [ ] **Step 2: Implement StepAudience**

Replace the entire contents of `src/components/upload-config/steps/StepAudience.jsx` with:

```jsx
// src/components/upload-config/steps/StepAudience.jsx
import { useEffect, useRef, useState } from 'react'
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'
import FieldCard from '../primitives/FieldCard.jsx'
import CheckPill from '../primitives/CheckPill.jsx'

const AGE_GROUPS = [
  { id: 'gen_alpha',  label: 'Gen Alpha',  hint: '< 13' },
  { id: 'teens',      label: 'Teens',      hint: '13–17' },
  { id: 'gen_z',      label: 'Gen Z',      hint: '18–24' },
  { id: 'millennial', label: 'Millennial', hint: '25–40' },
  { id: 'gen_x',      label: 'Gen X',      hint: '41–56' },
  { id: 'boomer',     label: 'Boomers',    hint: '57+' },
]

const SEX = [
  { id: 'any',       label: 'Any' },
  { id: 'female',    label: 'Female' },
  { id: 'male',      label: 'Male' },
  { id: 'nonbinary', label: 'Non-binary' },
]

const ETHNICITY = [
  { id: 'any',        label: 'Any / mixed' },
  { id: 'white',      label: 'White' },
  { id: 'black',      label: 'Black' },
  { id: 'hispanic',   label: 'Hispanic / Latino' },
  { id: 'asian_ea',   label: 'East Asian' },
  { id: 'asian_sa',   label: 'South Asian' },
  { id: 'mena',       label: 'MENA' },
  { id: 'indigenous', label: 'Indigenous' },
  { id: 'pacific',    label: 'Pacific Islander' },
]

const LANGUAGES = [
  'English', 'Spanish', 'Portuguese', 'French', 'German', 'Italian',
  'Mandarin', 'Japanese', 'Korean', 'Hindi', 'Arabic', 'Russian',
]

function LanguageSelect({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={[
          'w-full bg-surface-container-high rounded-md px-3.5 py-3 text-[13px] font-["Inter"] cursor-pointer',
          'flex items-center justify-between text-left transition-colors',
          value ? 'text-on-surface' : 'text-muted',
          open ? 'ring-1 ring-inset ring-lime/50' : 'ring-1 ring-inset ring-border-subtle/15',
        ].join(' ')}
      >
        <span>{value || 'Choose language…'}</span>
        <span className="material-symbols-outlined text-[18px]">
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>
      {open && (
        <div className="absolute top-[calc(100%+4px)] inset-x-0 z-20 bg-surface-container-highest rounded-lg max-h-[240px] overflow-y-auto ring-1 ring-inset ring-border-subtle/25 shadow-[0_8px_32px_rgba(0,0,0,0.6)]">
          {LANGUAGES.map(lang => (
            <div
              key={lang}
              onClick={() => { onChange(lang); setOpen(false) }}
              className={[
                'px-3.5 py-2.5 text-xs text-on-surface font-["Inter"] cursor-pointer',
                'flex items-center justify-between',
                value === lang ? 'bg-lime/8' : 'hover:bg-surface-container-high',
              ].join(' ')}
            >
              {lang}
              {value === lang && <span className="material-symbols-outlined text-[14px] text-lime">check</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TextField({ value, onChange, placeholder, icon }) {
  const [focus, setFocus] = useState(false)
  return (
    <div className={[
      'flex items-center gap-2.5 bg-surface-container-high rounded-md px-3.5 py-3 transition-colors',
      focus ? 'ring-1 ring-inset ring-lime/50' : 'ring-1 ring-inset ring-border-subtle/15',
    ].join(' ')}>
      {icon && <span className="material-symbols-outlined text-[16px] text-muted">{icon}</span>}
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        placeholder={placeholder}
        className="flex-1 bg-transparent border-none outline-none text-on-surface text-[13px] font-['Inter']"
      />
    </div>
  )
}

function TextArea({ value, onChange, placeholder, rows = 3 }) {
  const [focus, setFocus] = useState(false)
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      placeholder={placeholder}
      rows={rows}
      className={[
        'w-full bg-surface-container-high text-on-surface rounded-md px-3.5 py-3',
        'text-[13px] font-["Inter"] outline-none resize-y leading-[1.5] box-border',
        focus ? 'ring-1 ring-inset ring-lime/50' : 'ring-1 ring-inset ring-border-subtle/15',
      ].join(' ')}
    />
  )
}

export default function StepAudience({ state, setState }) {
  const audience = state.audience

  const toggleMulti = (key, val) => {
    const list = audience[key] || []
    const next = list.includes(val) ? list.filter(x => x !== val) : [...list, val]
    setState.audience({ ...audience, [key]: next })
  }
  const setField = (key, val) => setState.audience({ ...audience, [key]: val })

  return (
    <div>
      <div className="mb-7">
        <Eyebrow icon="groups" tone="secondary">Audience Signal · Step 3 of 6</Eyebrow>
        <div className="mt-3.5">
          <PageTitle line1="Who is this video" line2="speaking to?" accentTone="primary" size={26} />
        </div>
        <p className="mt-3 text-on-surface-variant text-[13px] max-w-[640px] leading-[1.6]">
          These signals feed the b-roll matcher so stock footage reflects the people your video is actually for.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-5 mb-5">
        <FieldCard label="Age Group" hint="Multi-select" icon="elderly">
          <div className="flex flex-wrap gap-2">
            {AGE_GROUPS.map(g => (
              <CheckPill
                key={g.id}
                checked={(audience.age || []).includes(g.id)}
                onChange={() => toggleMulti('age', g.id)}
                label={<span>{g.label} <span className="opacity-50 font-medium">· {g.hint}</span></span>}
                tone="primary"
              />
            ))}
          </div>
        </FieldCard>

        <FieldCard label="Sex / Gender" hint="Multi-select" icon="wc">
          <div className="flex flex-wrap gap-2">
            {SEX.map(s => (
              <CheckPill
                key={s.id}
                checked={(audience.sex || []).includes(s.id)}
                onChange={() => toggleMulti('sex', s.id)}
                label={s.label}
                tone="primary"
              />
            ))}
          </div>
        </FieldCard>
      </div>

      <div className="mb-5">
        <FieldCard label="Ethnicity / Race" hint="Multi-select · used to guide casting in stock b-roll" icon="diversity_3">
          <div className="flex flex-wrap gap-2">
            {ETHNICITY.map(e => (
              <CheckPill
                key={e.id}
                checked={(audience.ethnicity || []).includes(e.id)}
                onChange={() => toggleMulti('ethnicity', e.id)}
                label={e.label}
                tone="tertiary"
              />
            ))}
          </div>
        </FieldCard>
      </div>

      <div className="grid grid-cols-2 gap-5 mb-5">
        <FieldCard label="Primary Language" hint="Single" icon="translate">
          <LanguageSelect value={audience.language} onChange={v => setField('language', v)} />
        </FieldCard>

        <FieldCard label="Region / Locale" hint="Optional" icon="public">
          <TextField
            value={audience.region || ''}
            onChange={v => setField('region', v)}
            placeholder="e.g. North America, LATAM, EMEA…"
            icon="location_on"
          />
        </FieldCard>
      </div>

      <FieldCard label="Extra Comments" hint="Optional" icon="edit_note">
        <TextArea
          value={audience.notes || ''}
          onChange={v => setField('notes', v)}
          placeholder="Anything else the matcher should know? e.g. 'Indie music fans, outdoor lifestyle — avoid corporate office shots.'"
          rows={3}
        />
      </FieldCard>
    </div>
  )
}
```

- [ ] **Step 3: Verify build**

```bash
npx vite build --mode development
```

- [ ] **Step 4: Manual visual check**

Navigate to the Audience step. Confirm each field renders, multi-selects toggle correctly, language dropdown opens/closes, textarea accepts input.

- [ ] **Step 5: Commit**

```bash
git add src/components/upload-config/steps/StepAudience.jsx
git commit -m "feat(upload-config): StepAudience — age/sex/ethnicity/language/region/notes"
```

---

### Task 12: Agent C — StepReferences + delete BRollExamplesModal

**Files:**
- Modify: `src/components/upload-config/steps/StepReferences.jsx` (replace placeholder)
- Delete: `src/components/views/BRollExamplesModal.jsx`

References:
- `~/Downloads/Adpunk/step-references.jsx` (new design)
- `src/components/views/BRollExamplesModal.jsx` (existing API wiring to port)

- [ ] **Step 1: Read both references**

- `~/Downloads/Adpunk/step-references.jsx` — layout + UX, simulated data with setTimeout transitions.
- `src/components/views/BRollExamplesModal.jsx` — actual API integration (`/broll/groups/:id/examples`, upload endpoint, `apiDelete`, `apiPut` for favorite, polling every 3s while processing).

The port keeps the real API calls but matches the new layout.

- [ ] **Step 2: Implement StepReferences**

Replace the entire contents of `src/components/upload-config/steps/StepReferences.jsx` with:

```jsx
// src/components/upload-config/steps/StepReferences.jsx
import { useEffect, useRef, useState } from 'react'
import { useApi, apiPost, apiPut, apiDelete } from '../../../hooks/useApi.js'
import { supabase } from '../../../lib/supabaseClient.js'
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'

const API_BASE = import.meta.env.VITE_API_URL || '/api'
const MAX_REFERENCES = 3

function ytThumbnail(url) {
  if (!url) return null
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/)
  return m ? `https://img.youtube.com/vi/${m[1]}/mqdefault.jpg` : null
}

function StatusBadge({ status }) {
  const styles = {
    ready:      { bg: 'bg-lime/12',          fg: 'text-lime',          label: 'Ready',       pulse: false },
    processing: { bg: 'bg-purple-accent/12', fg: 'text-purple-accent', label: 'Downloading', pulse: true },
    failed:     { bg: 'bg-red-500/12',       fg: 'text-red-400',       label: 'Failed',      pulse: false },
    pending:    { bg: 'bg-white/4',          fg: 'text-on-surface-variant', label: 'Pending', pulse: false },
  }
  const s = styles[status] || styles.pending
  return (
    <span className={[
      'text-[9px] px-[7px] py-[3px] rounded uppercase font-extrabold tracking-[0.12em] font-["Inter"] shrink-0',
      s.bg, s.fg, s.pulse ? 'animate-pulse' : '',
    ].join(' ')}>
      {s.label}
    </span>
  )
}

function RefCard({ item, onRemove, onFavorite }) {
  const [hover, setHover] = useState(false)
  const thumb = ytThumbnail(item.source_url) || (item.meta_json && JSON.parse(item.meta_json || '{}').thumbnailUrl)

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'bg-surface-container-low rounded-[10px] p-2.5 flex flex-col gap-2 transition-all',
        item.is_favorite
          ? 'ring-[1.5px] ring-inset ring-lime/50 shadow-[0_0_20px_rgba(206,252,0,0.1)]'
          : 'ring-1 ring-inset ring-border-subtle/15',
      ].join(' ')}
    >
      <div className="aspect-video bg-surface-container-high rounded-md overflow-hidden relative">
        {thumb
          ? <img src={thumb} alt="" className="w-full h-full object-cover" />
          : (
            <div className="w-full h-full flex items-center justify-center text-on-surface-variant/30">
              <span className="material-symbols-outlined text-[32px]">
                {item.kind === 'upload' ? 'movie' : 'smart_display'}
              </span>
            </div>
          )}
        <a
          href={item.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute inset-0 flex items-center justify-center bg-black/35"
          onClick={e => e.stopPropagation()}
        >
          <span className="material-symbols-outlined text-[36px] text-lime drop-shadow-lg">play_circle</span>
        </a>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onFavorite() }}
          title={item.is_favorite ? 'Favorite (main plan)' : 'Set as favorite'}
          className={[
            'absolute top-1.5 right-1.5 w-6 h-6 rounded border-none bg-black/60 flex items-center justify-center cursor-pointer transition-colors',
            item.is_favorite ? 'text-lime' : 'text-white/60 hover:text-lime',
          ].join(' ')}
        >
          <span className="material-symbols-outlined text-[16px]" style={{ fontVariationSettings: `"FILL" ${item.is_favorite ? 1 : 0}` }}>
            star
          </span>
        </button>
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onRemove() }}
          className={[
            'absolute top-1.5 left-1.5 w-6 h-6 rounded border-none bg-black/60 flex items-center justify-center cursor-pointer transition-colors',
            hover ? 'text-red-400' : 'text-white/60',
          ].join(' ')}
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      </div>
      <div className="flex justify-between items-center gap-2">
        <span className="text-[10px] text-on-surface-variant font-['Inter'] truncate flex-1 font-medium">
          {item.label || item.source_url || `Video #${item.id}`}
        </span>
        <StatusBadge status={item.status} />
      </div>
    </div>
  )
}

function EmptySlot() {
  return (
    <div className="bg-surface-container-low rounded-[10px] p-2.5 border-2 border-dashed border-border-subtle/25 flex items-center justify-center aspect-[16/12]">
      <span className="material-symbols-outlined text-[32px] text-on-surface-variant/25">add</span>
    </div>
  )
}

export default function StepReferences({ groupId }) {
  const { data: items, refetch, mutate } = useApi(`/broll/groups/${groupId}/examples`)
  const [videoUrls, setVideoUrls] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const fileRef = useRef(null)

  const list = items || []
  const atLimit = list.length >= MAX_REFERENCES
  const hasSources = list.length > 0
  const needsMore = list.length < 2
  const hasFavorite = list.some(s => s.is_favorite)
  const hasProcessing = list.some(s => s.status === 'pending' || s.status === 'processing')

  useEffect(() => {
    if (!hasProcessing) return
    const interval = setInterval(refetch, 3000)
    return () => clearInterval(interval)
  }, [hasProcessing, refetch])

  async function handleAddVideos(e) {
    e?.preventDefault()
    const urls = videoUrls.split(',').map(u => u.trim()).filter(Boolean)
    if (!urls.length) return
    setSubmitting(true)
    try {
      let addedCount = 0
      for (const u of urls) {
        if (list.length + addedCount >= MAX_REFERENCES) break
        const added = await apiPost(`/broll/groups/${groupId}/examples`, {
          kind: 'yt_video',
          source_url: u,
        })
        mutate(prev => [added, ...(prev || []).filter(s => s.id !== added.id)])
        addedCount++
      }
      setVideoUrls('')
      refetch(true)
    } catch (err) {
      alert(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleFileUpload(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    setSubmitting(true)
    try {
      for (const file of files) {
        if (list.length >= MAX_REFERENCES) break
        const form = new FormData()
        form.append('file', file)
        form.append('label', file.name.replace(/\.[^/.]+$/, ''))
        const headers = {}
        if (supabase) {
          const { data } = await supabase.auth.getSession()
          if (data.session?.access_token) headers['Authorization'] = `Bearer ${data.session.access_token}`
        }
        const res = await fetch(`${API_BASE}/broll/groups/${groupId}/examples/upload`, {
          method: 'POST',
          headers,
          body: form,
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }))
          throw new Error(err.error || 'Upload failed')
        }
        const added = await res.json()
        mutate(prev => [added, ...(prev || []).filter(s => s.id !== added.id)])
      }
      refetch(true)
    } catch (err) {
      alert(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const remove = async id => { await apiDelete(`/broll/examples/${id}`); refetch() }
  const setFavorite = async id => { await apiPut(`/broll/examples/${id}/favorite`); refetch() }

  const slots = []
  for (let i = 0; i < MAX_REFERENCES; i++) slots.push(list[i] || null)

  return (
    <div>
      <div className="mb-7">
        <Eyebrow icon="auto_awesome" tone="secondary">Reference Videos · Step 4 of 6</Eyebrow>
        <div className="mt-3.5">
          <PageTitle line1="AI Context:" line2="Add Reference Videos" accentTone="primary" size={26} />
        </div>
        <p className="mt-3 text-on-surface-variant text-[13px] max-w-[680px] leading-[1.6]">
          Feed the AI with references. These examples will calibrate the AI's understanding of your b-roll selection,
          pacing, and transition style.
        </p>
      </div>

      <div className="bg-black p-6 rounded-xl ring-1 ring-inset ring-border-subtle/10 mb-5">
        <div className="flex items-center gap-3 mb-[18px]">
          <div className="w-9 h-9 rounded-lg bg-surface-container-high text-purple-accent flex items-center justify-center">
            <span className="material-symbols-outlined text-[20px]" style={{ fontVariationSettings: '"FILL" 1' }}>smart_display</span>
          </div>
          <div className="text-[15px] font-bold text-on-surface font-['Inter']">YouTube Videos</div>
        </div>

        <form onSubmit={handleAddVideos} className="flex gap-2 mb-5">
          <div className="flex-1 relative">
            <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-[16px] text-muted">link</span>
            <input
              type="text"
              value={videoUrls}
              onChange={e => setVideoUrls(e.target.value)}
              placeholder="Enter video URLs separated by commas…"
              disabled={atLimit || submitting}
              className="w-full bg-surface-container-high text-on-surface ring-1 ring-inset ring-border-subtle/15 rounded-lg py-3 pl-10 pr-4 text-[13px] font-['Inter'] outline-none disabled:opacity-50 focus:ring-lime/30 box-border"
            />
          </div>
          <button
            type="submit"
            disabled={submitting || !videoUrls.trim() || atLimit}
            className="px-6 bg-surface-container-high text-on-surface rounded-lg text-xs font-bold font-['Inter'] uppercase tracking-[0.15em] disabled:opacity-40 hover:bg-surface-container-highest transition-colors"
          >
            {submitting ? 'Adding…' : 'Fetch'}
          </button>
        </form>

        <div className="grid grid-cols-3 gap-3.5">
          {slots.map((item, i) => item
            ? <RefCard key={item.id} item={item} onRemove={() => remove(item.id)} onFavorite={() => setFavorite(item.id)} />
            : <EmptySlot key={`empty-${i}`} />
          )}
        </div>
      </div>

      <div
        onClick={() => fileRef.current?.click()}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); handleFileUpload({ target: { files: e.dataTransfer.files, value: '' } }) }}
        className="bg-black p-6 rounded-xl cursor-pointer ring-1 ring-inset ring-border-subtle/10 hover:ring-lime/30 transition-all"
      >
        <div className="border-2 border-dashed border-border-subtle/25 rounded-[10px] py-7 px-5 text-center">
          <div className="w-12 h-12 rounded-full mx-auto mb-3 bg-surface-container-high text-lime flex items-center justify-center">
            <span className="material-symbols-outlined text-[22px]">upload_file</span>
          </div>
          <div className="text-sm font-bold text-on-surface font-['Inter'] mb-1">Local Reference Files</div>
          <div className="text-xs text-on-surface-variant font-['Inter']">
            Drag and drop <span className="text-on-surface font-mono">.mp4</span> or{' '}
            <span className="text-on-surface font-mono">.mov</span> files here
          </div>
          <div className="mt-3.5 flex gap-2 justify-center">
            <span className="px-2.5 py-1 rounded bg-surface-container-high text-[10px] font-bold uppercase text-on-surface-variant font-['Inter']">H.264 / HEVC</span>
            <span className="px-2.5 py-1 rounded bg-surface-container-high text-[10px] font-bold uppercase text-on-surface-variant font-['Inter']">Max 2GB per file</span>
          </div>
        </div>
        <input ref={fileRef} type="file" accept=".mp4,.mov" multiple className="hidden" onChange={handleFileUpload} />
      </div>

      {hasSources && needsMore && (
        <div className="mt-4 flex items-center gap-3 px-[18px] py-3 rounded-[10px] bg-purple-accent/5 ring-1 ring-inset ring-purple-accent/25">
          <span className="material-symbols-outlined text-[18px] text-purple-accent">add_circle</span>
          <span className="text-xs text-purple-accent/80 font-['Inter'] leading-[1.5]">
            Add at least 2 reference videos — the AI needs multiple examples to learn your b-roll style.
          </span>
        </div>
      )}
      {hasSources && !needsMore && !hasFavorite && (
        <div className="mt-4 flex items-center gap-3 px-[18px] py-3 rounded-[10px] bg-lime/5 ring-1 ring-inset ring-lime/25">
          <span className="material-symbols-outlined text-[18px] text-lime" style={{ fontVariationSettings: '"FILL" 1' }}>star</span>
          <span className="text-xs text-on-surface font-['Inter'] leading-[1.5]">
            Pick a favorite reference — it will drive the main B-Roll plan. Hover a video and click the star.
          </span>
        </div>
      )}

      <div className="mt-[18px] px-4 py-3 rounded-lg bg-surface-container-low ring-1 ring-inset ring-border-subtle/8 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="material-symbols-outlined text-[16px] text-lime">movie</span>
          <span className="text-[11px] text-on-surface-variant font-['Inter']">
            <span className="text-on-surface font-bold">{list.length}</span> / {MAX_REFERENCES} references added
          </span>
        </div>
        <span className="text-[10px] font-bold text-lime uppercase tracking-[0.2em] font-['Inter']">
          Max Examples: {MAX_REFERENCES}
        </span>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Delete BRollExamplesModal.jsx**

Confirm there are no remaining imports first:

```bash
grep -rn "BRollExamplesModal" src/ 2>/dev/null
```

Expected: no matches (Wave 1 Task 8 removed the import and usage).

Then:
```bash
rm src/components/views/BRollExamplesModal.jsx
```

- [ ] **Step 4: Verify build**

```bash
npx vite build --mode development
```

- [ ] **Step 5: Manual visual check**

Navigate to the References step. Confirm YT URLs can be added (they kick off processing and transition to Ready), file drop works, favorite star toggles, delete works.

- [ ] **Step 6: Commit**

```bash
git add src/components/upload-config/steps/StepReferences.jsx
git rm src/components/views/BRollExamplesModal.jsx
git commit -m "feat(upload-config): StepReferences — new design, remove BRollExamplesModal"
```

---

### Task 13: Agent D — StepPath + StepDone + pipeline wiring + BRollEditor auto-select

**Files:**
- Modify: `src/components/upload-config/steps/StepPath.jsx` (replace placeholder)
- Modify: `src/components/upload-config/steps/StepDone.jsx` (replace placeholder)
- Modify: `server/routes/broll.js:479` (derive flags from `path_id`)
- Modify: `server/services/broll.js` (add `stop_after_strategy` to the pipeline runner)
- Modify: `src/components/editor/BRollEditor.jsx` (auto-select variants for `hands-off`)
- Create: `server/routes/__tests__/broll-path-flags.test.js`

References:
- `~/Downloads/Adpunk/step-path.jsx` (PathCard + StepPath)
- `~/Downloads/Adpunk/step-done.jsx` (summary)
- `server/routes/broll.js:479-510` (current `stop_after_plan` consumption)
- `src/components/editor/BRollEditor.jsx:19-75` (current variant-switching)

- [ ] **Step 1: Implement StepPath**

Replace the entire contents of `src/components/upload-config/steps/StepPath.jsx` with:

```jsx
// src/components/upload-config/steps/StepPath.jsx
import { useState } from 'react'
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'

const PATHS = [
  {
    id: 'hands-off',
    badge: 'A · HANDS-OFF',
    title: 'Full Auto',
    subtitle: 'Start now, email when b-roll is ready',
    tone: 'secondary',
    icon: 'rocket_launch',
    flow: [
      { label: 'References analyzed', status: 'auto' },
      { label: 'Strategy proposal',   status: 'auto' },
      { label: 'B-roll plan',         status: 'auto' },
      { label: 'Search & download',   status: 'auto' },
      { label: 'Final review',        status: 'review', checkpoint: true },
    ],
    eta: '~18–24 hrs for a 40-min video',
    note: 'Kick it off and walk away — you review at the end before the cut goes live.',
  },
  {
    id: 'strategy-only',
    badge: 'B · BALANCED',
    title: 'Strategy Review',
    subtitle: 'Confirm the creative strategy, then we run',
    tone: 'tertiary',
    icon: 'center_focus_strong',
    flow: [
      { label: 'References analyzed', status: 'auto' },
      { label: 'Strategy proposal',   status: 'review', checkpoint: true },
      { label: 'B-roll plan',         status: 'auto' },
      { label: 'Search & download',   status: 'auto' },
      { label: 'Final review',        status: 'review', checkpoint: true },
    ],
    eta: '~20–28 hrs for a 40-min video',
    note: "Each checkpoint waits on your login — without it, the next phase won't start.",
    warn: true,
  },
  {
    id: 'guided',
    badge: 'C · FULL CONTROL',
    title: 'Guided Review',
    subtitle: 'Review and confirm at every step',
    tone: 'primary',
    icon: 'account_tree',
    flow: [
      { label: 'References analyzed', status: 'auto' },
      { label: 'Strategy proposal',   status: 'review', checkpoint: true },
      { label: 'B-roll plan',         status: 'review', checkpoint: true },
      { label: 'Search & download',   status: 'auto' },
      { label: 'Final review',        status: 'review', checkpoint: true },
    ],
    eta: '~24–36 hrs for a 40-min video',
    note: "Each checkpoint waits on your login — without it, the next phase won't start.",
    warn: true,
  },
]

function PathCard({ path, active, onSelect }) {
  const [hover, setHover] = useState(false)

  const accent = path.tone === 'primary' ? 'text-lime'
    : path.tone === 'tertiary' ? 'text-teal'
    : 'text-purple-accent'
  const accentBg = path.tone === 'primary' ? 'bg-lime/12'
    : path.tone === 'tertiary' ? 'bg-teal/12'
    : 'bg-purple-accent/12'
  const checkpointBg = path.tone === 'primary' ? 'bg-lime/5'
    : path.tone === 'tertiary' ? 'bg-teal/5'
    : 'bg-purple-accent/5'
  const ringClass = path.tone === 'primary'
    ? 'ring-lime shadow-[0_0_28px_rgba(206,252,0,0.10)]'
    : path.tone === 'tertiary'
      ? 'ring-teal shadow-[0_0_28px_rgba(45,212,191,0.10)]'
      : 'ring-purple-accent shadow-[0_0_28px_rgba(193,128,255,0.14)]'

  return (
    <div
      onClick={() => onSelect(path.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={[
        'rounded-[14px] p-[22px] cursor-pointer flex flex-col gap-4 transition-all relative',
        active
          ? `bg-surface-container-high ring-[1.5px] ring-inset ${ringClass}`
          : hover
            ? 'bg-surface-container-highest ring-1 ring-inset ring-border-subtle/10'
            : 'bg-surface-container-low ring-1 ring-inset ring-border-subtle/10',
      ].join(' ')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-2.5 min-w-0 flex-1">
          <span className={`text-[9px] font-extrabold tracking-[0.22em] uppercase font-['Inter'] ${accent}`}>
            {path.badge}
          </span>
          <div className="text-lg font-bold text-on-surface leading-[1.15] tracking-tight font-['Inter']">
            {path.title}
          </div>
          <div className="text-xs text-on-surface-variant font-['Inter'] leading-[1.4]">
            {path.subtitle}
          </div>
        </div>
        <div className={[
          'w-11 h-11 rounded-[10px] shrink-0 flex items-center justify-center',
          active ? `${accentBg} ${accent}` : 'bg-surface-container-high text-on-surface-variant',
        ].join(' ')}>
          <span className="material-symbols-outlined text-[22px]" style={{ fontVariationSettings: `"FILL" ${active ? 1 : 0}` }}>
            {path.icon}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5 mt-1">
        {path.flow.map((f, i) => (
          <div key={i} className={[
            'flex items-center gap-2.5 px-2.5 py-[7px] rounded-md',
            f.checkpoint ? checkpointBg : 'bg-transparent',
          ].join(' ')}>
            <div className={[
              'w-[18px] h-[18px] rounded-full shrink-0 flex items-center justify-center',
              f.status === 'review'
                ? (path.tone === 'primary' ? 'bg-lime text-on-primary-container'
                  : path.tone === 'tertiary' ? 'bg-teal text-[#00201c]'
                  : 'bg-purple-accent text-[#33005b]')
                : 'bg-surface-container-high text-on-surface-variant',
            ].join(' ')}>
              <span className="material-symbols-outlined text-[11px]" style={{ fontVariationSettings: '"wght" 700' }}>
                {f.status === 'review' ? 'visibility' : 'auto_mode'}
              </span>
            </div>
            <span className={[
              'flex-1 text-[11px] font-["Inter"]',
              f.checkpoint ? 'text-on-surface font-semibold' : 'text-on-surface-variant font-medium',
            ].join(' ')}>
              {f.label}
            </span>
            {f.checkpoint && (
              <span className={`text-[9px] font-bold uppercase tracking-[0.15em] font-['Inter'] ${accent}`}>
                You review
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="mt-auto pt-3.5 ring-[0.5px] ring-inset ring-white/3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[13px] text-muted">schedule</span>
          <span className="text-[11px] text-on-surface-variant font-mono tabular-nums">{path.eta}</span>
        </div>
        <p className={[
          'text-[11px] leading-[1.5] m-0 font-["Inter"]',
          path.warn ? 'text-orange-400' : 'text-muted',
        ].join(' ')}>
          {path.warn && (
            <span className="material-symbols-outlined text-[12px] align-middle mr-1.5" style={{ fontVariationSettings: '"FILL" 1' }}>warning</span>
          )}
          {path.note}
        </p>
      </div>
    </div>
  )
}

export default function StepPath({ state, setState }) {
  return (
    <div>
      <div className="mb-6">
        <Eyebrow icon="fork_right" tone="secondary">Automation · Step 5 of 6</Eyebrow>
        <div className="mt-3.5">
          <PageTitle line1="How hands-on" line2="do you want to be?" accentTone="primary" size={26} />
        </div>
        <p className="mt-3 text-on-surface-variant text-[13px] max-w-[720px] leading-[1.6]">
          B-roll search is long-running — for a 40-minute video, expect somewhere between 18 and 36 hours end-to-end.
          Pick how many review checkpoints you want along the way.{' '}
          <span className="text-on-surface font-semibold">You must be logged in to confirm each checkpoint, or we pause.</span>
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3.5 mb-4">
        {PATHS.map(p => (
          <PathCard key={p.id} path={p} active={state.pathId === p.id} onSelect={setState.pathId} />
        ))}
      </div>

      <div className="px-[18px] py-3.5 rounded-[10px] bg-orange-500/5 ring-1 ring-inset ring-orange-500/20 flex items-start gap-3">
        <span className="material-symbols-outlined text-[18px] text-orange-400 shrink-0 mt-px" style={{ fontVariationSettings: '"FILL" 1' }}>report</span>
        <div className="text-xs text-on-surface-variant leading-[1.6] font-['Inter']">
          <span className="text-orange-400 font-bold uppercase tracking-[0.12em] text-[10px] mr-2">Important</span>
          Every path ends with a final review after search & download.
          Mid-run checkpoints may wait 15–20 minutes for analysis before asking you —
          we'll email and notify when your input is needed. You can switch paths mid-run from the project dashboard.
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Implement StepDone**

Replace the entire contents of `src/components/upload-config/steps/StepDone.jsx` with:

```jsx
// src/components/upload-config/steps/StepDone.jsx
import Eyebrow from '../primitives/Eyebrow.jsx'
import PageTitle from '../primitives/PageTitle.jsx'

function SummaryRow({ label, value, tone }) {
  const color = tone === 'primary' ? 'text-lime'
    : tone === 'tertiary' ? 'text-teal'
    : 'text-purple-accent'
  return (
    <div className="flex items-baseline gap-4">
      <span className={`text-[9px] font-extrabold tracking-[0.2em] uppercase font-['Inter'] min-w-[130px] shrink-0 ${color}`}>
        {label}
      </span>
      <span className="text-xs text-on-surface font-['Inter'] leading-[1.5]">{value}</span>
    </div>
  )
}

function summarizeLibs(libs, freepik) {
  if (!libs || !libs.length) return `Pexels${freepik ? ' + Freepik ($0.05/clip, confirmed)' : ' only'}`
  const map = { envato: 'Envato', artlist: 'Artlist', storyblocks: 'Storyblocks' }
  return libs.map(l => map[l] || l).join(' · ')
}

function summarizeAudience(a) {
  if (!a) return 'No signals yet'
  const parts = []
  if (a.age?.length) parts.push(`${a.age.length} age group${a.age.length > 1 ? 's' : ''}`)
  if (a.sex?.length) parts.push(a.sex.join('/'))
  if (a.language) parts.push(a.language)
  return parts.length ? parts.join(' · ') : 'No signals yet'
}

function summarizePath(id) {
  return ({
    'guided':        'C · Guided Review',
    'strategy-only': 'B · Strategy Review',
    'hands-off':     'A · Full Auto',
  }[id]) || '—'
}

export default function StepDone({ state, onEdit, onComplete }) {
  return (
    <div className="text-center py-5">
      <div className="w-[88px] h-[88px] rounded-full mx-auto mb-6 bg-lime/10 flex items-center justify-center text-lime ring-[1.5px] ring-inset ring-lime/35 shadow-[0_0_48px_rgba(206,252,0,0.25)]">
        <span className="material-symbols-outlined text-[44px]" style={{ fontVariationSettings: '"wght" 700' }}>check</span>
      </div>
      <Eyebrow tone="primary" icon="check_circle">Configuration Saved</Eyebrow>
      <div className="mt-4">
        <PageTitle line1="Ready for" line2="calibration" accentTone="primary" size={26} />
      </div>
      <p className="mt-3 text-on-surface-variant text-[13px] max-w-[520px] leading-[1.6] mx-auto">
        Your preferences are saved to this project. Uploading video now — the Kinetic Engine will start
        analyzing as soon as encoding completes.
      </p>

      <div className="mt-7 inline-flex flex-col gap-2.5 p-5 rounded-xl bg-surface-container-low ring-1 ring-inset ring-border-subtle/12 text-left min-w-[420px]">
        <SummaryRow label="B-Roll Sources"   value={summarizeLibs(state.libraries, state.freepikOptIn)} tone="tertiary" />
        <SummaryRow label="Target Audience"  value={summarizeAudience(state.audience)} tone="secondary" />
        <SummaryRow label="Path"             value={summarizePath(state.pathId)} tone="primary" />
      </div>

      <div className="mt-6 flex justify-center gap-3">
        <button
          type="button"
          onClick={onEdit}
          className="inline-flex items-center gap-2 text-on-surface-variant font-bold text-xs uppercase tracking-widest px-4 py-2 hover:text-on-surface transition-colors"
        >
          <span className="material-symbols-outlined text-sm">edit</span>
          Edit Config
        </button>
        <button
          type="button"
          onClick={onComplete}
          className="inline-flex items-center gap-2.5 bg-gradient-to-br from-lime to-primary-dim text-on-primary-container font-extrabold text-xs uppercase tracking-[0.15em] px-7 py-3.5 rounded-md shadow-[0_0_32px_rgba(206,252,0,0.25)] hover:shadow-[0_0_48px_rgba(206,252,0,0.45)] active:scale-95 transition-all"
        >
          <span className="material-symbols-outlined text-sm">play_arrow</span>
          Proceed to Editor
          <span className="material-symbols-outlined text-sm">arrow_forward</span>
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Derive pipeline flags from path_id**

Read `server/routes/broll.js` around line 479 to find the POST handler that takes `stop_after_plan`. Replace the destructuring to read from the group's stored `path_id`:

```js
// in server/routes/broll.js — extract the pathId→flags derivation into a helper near the top
export function pathToFlags(pathId) {
  switch (pathId) {
    case 'hands-off':
      return { stopAfterStrategy: false, stopAfterPlan: false, autoSelectVariants: true }
    case 'strategy-only':
      return { stopAfterStrategy: true,  stopAfterPlan: false, autoSelectVariants: false }
    case 'guided':
      return { stopAfterStrategy: true,  stopAfterPlan: true,  autoSelectVariants: false }
    default:
      // legacy / unset: behave as strategy-only for safety
      return { stopAfterStrategy: true, stopAfterPlan: false, autoSelectVariants: false }
  }
}
```

Then in the POST body of the b-roll run route (the handler that currently destructures `stop_after_plan`), replace the destructuring:

```js
const { video_id, group_id, transcript_source, reference_run_id, example_video_id } = req.body || {}

// Fetch group to read path_id
let pathId = null
if (group_id) {
  const row = await db.prepare('SELECT path_id FROM video_groups WHERE id = ?').get(group_id)
  pathId = row?.path_id || null
}
const { stopAfterStrategy, stopAfterPlan } = pathToFlags(pathId)
```

And pass both flags into `startBrollRun`:
```js
{ stopAfterPlan, stopAfterStrategy, exampleVideoId: example_video_id || null }
```

- [ ] **Step 4: Add `stop_after_strategy` support to the pipeline runner**

Open `server/services/broll.js`. Find the function that consumes `stopAfterPlan` (search: `stopAfterPlan`). Mirror the same pattern for `stopAfterStrategy`: after the strategy stage completes, check the flag and halt the pipeline with the same paused-state machinery `stopAfterPlan` uses.

The exact code will depend on what's there — read the existing stopAfterPlan branch, duplicate it at the right stage, test with the unit test in Step 6.

- [ ] **Step 5: Auto-select variants in BRollEditor for hands-off**

Open `src/components/editor/BRollEditor.jsx`. Around lines 19–75 is the variant-switching logic. Find the component's props and add a `pathId` prop. The caller (look for `<BRollEditor` in `EditorView.jsx` or parent) needs to pass `group.path_id`.

Then inside the component, after the `variants` computation:
```jsx
useEffect(() => {
  if (pathId === 'hands-off' && variants.length > 1 && activeVariantIdx === 0) {
    // auto-activate all variants — trigger the same handler the manual picker uses.
    // Exact wiring depends on how variants get activated today; re-use that code path.
    // If no multi-active API exists yet, at minimum mark that the user skipped the picker.
  }
}, [pathId, variants, activeVariantIdx])
```

Because the multi-variant activation API may not exist, at minimum this iteration:
1. Add the `pathId` prop.
2. Skip showing the variant picker UI entirely when `pathId === 'hands-off'`.
3. Use the default `activeVariantIdx=0` behavior (current first-variant default) — the user can switch manually later from the editor.

The spec allows this minimal version for the first iteration; a richer "all active at once" can follow.

- [ ] **Step 6: Write the pathToFlags test**

Create `server/routes/__tests__/broll-path-flags.test.js`:

```js
// server/routes/__tests__/broll-path-flags.test.js
import { describe, it, expect } from 'vitest'
import { pathToFlags } from '../broll.js'

describe('pathToFlags', () => {
  it('hands-off: no stops, auto-select variants', () => {
    expect(pathToFlags('hands-off')).toEqual({
      stopAfterStrategy: false,
      stopAfterPlan: false,
      autoSelectVariants: true,
    })
  })

  it('strategy-only: stop after strategy only', () => {
    expect(pathToFlags('strategy-only')).toEqual({
      stopAfterStrategy: true,
      stopAfterPlan: false,
      autoSelectVariants: false,
    })
  })

  it('guided: stop after strategy AND plan', () => {
    expect(pathToFlags('guided')).toEqual({
      stopAfterStrategy: true,
      stopAfterPlan: true,
      autoSelectVariants: false,
    })
  })

  it('null / unknown: defaults to strategy-only behavior', () => {
    expect(pathToFlags(null)).toEqual({
      stopAfterStrategy: true,
      stopAfterPlan: false,
      autoSelectVariants: false,
    })
    expect(pathToFlags('unknown-value')).toEqual({
      stopAfterStrategy: true,
      stopAfterPlan: false,
      autoSelectVariants: false,
    })
  })
})
```

- [ ] **Step 7: Run the test**

```bash
npm run test -- server/routes/__tests__/broll-path-flags.test.js
```

Expected: 4 passing.

- [ ] **Step 8: Visual smoke test**

Run `npm run dev`. Click through the flow end-to-end. On the Path step confirm all three tiles render, click Full Auto (hands-off), continue to StepDone, confirm summary shows "A · Full Auto", click Proceed to Editor.

- [ ] **Step 9: Commit**

```bash
git add src/components/upload-config/steps/StepPath.jsx \
        src/components/upload-config/steps/StepDone.jsx \
        server/routes/broll.js \
        server/services/broll.js \
        server/routes/__tests__/broll-path-flags.test.js \
        src/components/editor/BRollEditor.jsx
git commit -m "feat(upload-config): StepPath + StepDone, pipeline flags from path_id, auto-skip variant picker for hands-off"
```

---

## Post-Wave-2 handoff

After all four Wave 2 agents commit:

- [ ] Run full test suite: `npm run test`. Expect all pre-existing + the 13 new tests (9 validateGroupUpdate + 4 pathToFlags) to pass.
- [ ] Build: `npm run build`. Must finish clean.
- [ ] Manual end-to-end smoke: upload → libraries → audience → references → path → done → editor. Record findings.
- [ ] Open PR from `feature/upload-config-redesign` → `main`. Link this plan and the design doc.

---

## Self-Review

**1. Spec coverage:**
- Libraries step → Task 10 ✓
- Audience step → Task 11 ✓
- References step (replace BRollExamplesModal) → Task 12 ✓
- Path step + behavior wiring → Task 13 (frontend + backend) ✓
- Remove RoughCutConfigModal + defaults → Task 5 (defaults) + Task 8 (delete) ✓
- New DB columns → Task 4 ✓
- API extension → Task 5 ✓
- UploadConfigFlow orchestrator → Task 7 ✓
- Stepper → Task 3 ✓
- Primitives → Task 2 ✓
- Legacy URL redirect → Task 8 Step 4 ✓
- Worktree → Task 1 ✓

**2. Placeholder scan:**
- Task 13 Step 5 "exact wiring depends on how variants get activated today" — acknowledged; agent reads existing code. Marked as minimal-viable iteration per spec's "out of scope: full email gating" and follow-up-allowed framing. Acceptable because a concrete fallback is stated (hide picker + default-first). Not a blocker.
- Task 13 Step 4 "read the existing stopAfterPlan branch, duplicate it" — same pattern, acceptable: reference code is named, agent reads + mirrors. Concrete enough.
- No "TBD" / "implement later" / "add error handling" / "similar to Task N" patterns.

**3. Type / naming consistency:**
- `pathId` / `path_id` — camelCase client, snake_case DB. Consistent.
- `freepikOptIn` / `freepik_opt_in` — same pattern. Consistent.
- `libraries` state array, `libraries_json` DB column. `libraries` on the wire (since PUT body is JSON the server then JSON-encodes). Consistent.
- `pathToFlags` returns `{stopAfterStrategy, stopAfterPlan, autoSelectVariants}`. Used in Task 13 Step 3 + Step 6 test — matches.
- `CONFIG_STEPS` set in ProjectsView (Task 8 Step 3) uses `libraries|audience|references|path` — matches UploadConfigFlow's `UNIFIED_STEPS.slice(1, 5)` labels.

No gaps or inconsistencies.
