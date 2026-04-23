# Envato Export — Phase 1 (DB + Server Routes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the backend surface for the b-roll export feature: two new tables (`exports`, `export_events`) and the four HTTP endpoints the Chrome extension + web app will call during export (`POST /api/exports`, `POST /api/session-token`, `POST /api/export-events`, `POST /api/pexels-url`, `POST /api/freepik-url`). No frontend, no extension, no XMEML — those land in later phases.

**Architecture:** Two new Postgres tables added in `server/schema-pg.sql` with matching `CREATE TABLE IF NOT EXISTS` migrations in `server/db.js` (the project pattern for schema evolution — new tables in both places so fresh installs and deployed DBs converge). All endpoints live behind a single new router `server/routes/exports.js` backed by service modules `server/services/exports.js`, `server/services/ext-jwt.js`, and `server/services/freepik.js`. Two auth surfaces coexist: the existing Supabase JWT (`requireAuth` from `server/auth.js`) protects web-app-initiated routes (`/exports`, `/session-token`); a new extension-minted JWT (HS256 via `jose`, keyed by `kid` for future rotation) protects extension-initiated routes (`/export-events`, `/pexels-url`, `/freepik-url`). Slack alerts reuse the existing `server/services/slack-notifier.js`. No admin UI, no DSAR endpoint, no nightly purge — those are Phase 9/10.

**Tech Stack:** Node 20 + Express 5 + `pg` + Supabase Postgres via Supavisor transaction-mode pooler (port 6543). `jose` ^6.2.2 for JWT sign/verify. New runtime dep: `ulid` (tiny, ~3 KB). ES modules, no TypeScript.

**Repo has no test framework** — verification is explicit curl/log/DB checks, same as `2026-04-22-db-pool-structural-fix.md`.

**Working directory note:** The project path contains a trailing space: `/Users/laurynas/Desktop/one last /transcript-eval/`. Quote every path. Examples in this plan use the shell variable `TE` set at the top of each task.

---

## File Structure

| File | Responsibility | Change kind |
|---|---|---|
| `server/schema-pg.sql` | Canonical schema for fresh DBs | Add `exports` + `export_events` tables + 3 indexes |
| `server/db.js` | Schema init + idempotent migrations for deployed DBs | Add matching `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` in the migrations block |
| `server/services/exports.js` | Export business logic + ID minting + Slack dedupe | New file (~170 LOC) |
| `server/services/ext-jwt.js` | Extension JWT mint + verify + middleware | New file (~110 LOC) |
| `server/services/freepik.js` | Minimal Freepik API client (signed download URL) | New file (~75 LOC) |
| `server/services/pexels.js` | Existing Pexels client | Extend: add `pickBestVideoFile(video, preferredHeight)` helper |
| `server/routes/exports.js` | All Phase 1 HTTP endpoints | New file (~220 LOC) |
| `server/index.js` | Wire new router | +1 import, +1 `app.use()` |
| `package.json` | Dependency declaration | Add `ulid` |
| `.env.example` | Env var docs (if missing, create) | Add `EXT_JWT_KEYS`, `EXT_JWT_CURRENT_KID`, `FREEPIK_API_KEY` |

---

## Task 1: Add `exports` + `export_events` tables

**Files:**
- Modify: `server/schema-pg.sql` (append after line 317)
- Modify: `server/db.js:45-88` (migrations block)

**Why first:** All subsequent routes read or write these tables. Shipping the schema alone is safe — no code references the tables yet.

**Design notes baked into the schema:**
- `id TEXT PRIMARY KEY` — ULID (26 chars) with `exp_` prefix, so `exp_01JZK...`. TEXT, not UUID type, because the prefix + lexicographic sortability matter.
- `user_id TEXT` added to `exports` (not in spec's raw DDL but required by admin-per-user view in Phase 9 and by the `/export-events` route in this phase to scope event writes to the owner).
- `created_at` / `completed_at` use `TIMESTAMPTZ` (matches every other table in `schema-pg.sql`). The spec draft wrote `INTEGER`; TIMESTAMPTZ is chosen for consistency with existing admin queries (`ORDER BY created_at DESC`) and migrations.
- `export_events.t` and `export_events.received_at` stay `BIGINT` (epoch_ms) per spec — these are event-stream timestamps with sub-second precision and are written by two clocks (client `t`, server `received_at`).
- `plan_pipeline_id` is `TEXT` (matches `broll_searches.plan_pipeline_id` in existing schema — spec's `INTEGER` was a drafting error).

- [ ] **Step 1: Append new tables to `server/schema-pg.sql`**

Append at end of file (after the `broll_example_sources` definition at line 317):

```sql

-- B-Roll Export Runs (one row per user-triggered export)
CREATE TABLE IF NOT EXISTS exports (
  id               TEXT PRIMARY KEY,              -- ULID with exp_ prefix
  user_id          TEXT,
  plan_pipeline_id TEXT NOT NULL,                 -- matches broll_searches.plan_pipeline_id
  variant_labels   TEXT NOT NULL,                 -- JSON array, e.g. ["C"] or ["A","B","C"]
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','complete','failed','partial')),
  manifest_json    TEXT NOT NULL,                 -- full per-item manifest sent to extension
  result_json      TEXT,                          -- per-item status after run
  xml_paths        TEXT,                          -- JSON map: {"C":"variant-c.xml",...}
  folder_path      TEXT,                          -- redacted absolute path
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_exports_user_created ON exports(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exports_pipeline     ON exports(plan_pipeline_id);

-- B-Roll Export Event Stream (telemetry from extension)
CREATE TABLE IF NOT EXISTS export_events (
  id           BIGSERIAL PRIMARY KEY,
  export_id    TEXT NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
  user_id      TEXT,
  event        TEXT NOT NULL,
  item_id      TEXT,
  source       TEXT,
  phase        TEXT,
  error_code   TEXT,
  http_status  INTEGER,
  retry_count  INTEGER,
  meta_json    TEXT,
  t            BIGINT NOT NULL,                    -- client-stamped epoch_ms
  received_at  BIGINT NOT NULL                     -- server-stamped epoch_ms
);
CREATE INDEX IF NOT EXISTS idx_export_events_export   ON export_events(export_id, t);
CREATE INDEX IF NOT EXISTS idx_export_events_failures ON export_events(event, received_at)
  WHERE event IN ('item_failed','rate_limit_hit','session_expired');
```

- [ ] **Step 2: Add matching idempotent migrations to `server/db.js`**

Inside the existing `try { await pool.query(...) } catch {}` migrations block (starts at line 46), append before the final `catch {}`:

```javascript
    await pool.query(`CREATE TABLE IF NOT EXISTS exports (
      id               TEXT PRIMARY KEY,
      user_id          TEXT,
      plan_pipeline_id TEXT NOT NULL,
      variant_labels   TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','complete','failed','partial')),
      manifest_json    TEXT NOT NULL,
      result_json      TEXT,
      xml_paths        TEXT,
      folder_path      TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ
    )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_exports_user_created ON exports(user_id, created_at DESC)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_exports_pipeline ON exports(plan_pipeline_id)`)
    await pool.query(`CREATE TABLE IF NOT EXISTS export_events (
      id           BIGSERIAL PRIMARY KEY,
      export_id    TEXT NOT NULL REFERENCES exports(id) ON DELETE CASCADE,
      user_id      TEXT,
      event        TEXT NOT NULL,
      item_id      TEXT,
      source       TEXT,
      phase        TEXT,
      error_code   TEXT,
      http_status  INTEGER,
      retry_count  INTEGER,
      meta_json    TEXT,
      t            BIGINT NOT NULL,
      received_at  BIGINT NOT NULL
    )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_export_events_export ON export_events(export_id, t)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_export_events_failures ON export_events(event, received_at) WHERE event IN ('item_failed','rate_limit_hit','session_expired')`)
```

- [ ] **Step 3: Restart dev server and verify schema init**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
# Kill any stale dev server, then start in foreground so we can see the log
pkill -f "server/index.js" 2>/dev/null; sleep 1
node --env-file=.env server/index.js 2>&1 | head -20
```

Expected: output includes `[db] Schema initialized` and `Transcript Eval API running on http://localhost:3001`, with no `[db] Schema error:` lines. Hit Ctrl-C after confirmation.

- [ ] **Step 4: Confirm tables exist via a direct query**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
set -a && source .env && set +a
node -e '
import("pg").then(async ({default: pg}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}, max: 1 });
  const r1 = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_name IN ($1,$2) ORDER BY table_name", ["exports","export_events"]);
  console.log("tables:", r1.rows.map(r => r.table_name));
  const r2 = await pool.query("SELECT indexname FROM pg_indexes WHERE tablename IN ($1,$2) ORDER BY indexname", ["exports","export_events"]);
  console.log("indexes:", r2.rows.map(r => r.indexname));
  await pool.end();
});
'
```

Expected:
```
tables: [ 'export_events', 'exports' ]
indexes: [ 'export_events_pkey', 'exports_pkey', 'idx_export_events_export', 'idx_export_events_failures', 'idx_exports_pipeline', 'idx_exports_user_created' ]
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/schema-pg.sql server/db.js
git commit -m "$(cat <<'EOF'
feat(db): add exports + export_events tables for b-roll export feature

Phase 1 of the export pipeline. Two new tables with indexes on
(user_id, created_at), (plan_pipeline_id), and a partial index on
the failure event subset — the common query shape for admin
visibility in Phase 9.

Table DDL also added to schema-pg.sql so fresh installs stay
consistent with deployed DBs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: ULID helper for export IDs

**Files:**
- Modify: `package.json` (add `ulid` dep)
- Create: `server/services/exports.js`

**Why now:** Every subsequent endpoint that writes `exports.id` needs this helper; isolating it first gives a reusable + testable entry point.

- [ ] **Step 1: Install `ulid`**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
npm install ulid
```

Expected: `package.json` gets `"ulid": "^<version>"` in `dependencies`; `node_modules/ulid/` exists.

- [ ] **Step 2: Create `server/services/exports.js` with `mintExportId()`**

Create the file with this full content (we'll grow it in later tasks):

```javascript
// B-Roll export service. Phase 1 responsibilities:
// - mint export IDs (ULID with `exp_` prefix, lex-sortable by time)
// - create/update exports rows
// - insert export_events rows
// - fire Slack alerts on a dedupe window for the event types listed in
//   docs/specs/2026-04-23-envato-export-design.md § Slack alerting.

import { ulid } from 'ulid'
import db from '../db.js'
import { notify } from './slack-notifier.js'

export function mintExportId() {
  return `exp_${ulid()}`
}
```

- [ ] **Step 3: Smoke-test via node REPL**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node -e '
import("./server/services/exports.js").then(({ mintExportId }) => {
  const a = mintExportId();
  const b = mintExportId();
  console.log("a:", a);
  console.log("b:", b);
  if (!/^exp_[0-9A-HJKMNP-TV-Z]{26}$/.test(a)) throw new Error("bad ulid shape");
  if (a === b) throw new Error("ids collided");
  // ULID is time-ordered: b > a lexicographically when minted in order
  if (b <= a) throw new Error("ids not time-ordered");
  console.log("OK");
});
'
```

Expected: two lines starting with `exp_` followed by 26 alphanumerics, then `OK`. Any error throws and exits nonzero.

- [ ] **Step 4: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add package.json package-lock.json server/services/exports.js
git commit -m "$(cat <<'EOF'
feat(exports): add mintExportId helper (ULID with exp_ prefix)

Lex-sortable by time so admin queries can ORDER BY id DESC and get
the newest export without a secondary index. Reserves the services
module for the rest of the Phase 1 work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extension JWT signer + verifier

**Files:**
- Create: `server/services/ext-jwt.js`
- Create: `.env.example` if missing; otherwise modify

**Design:**
- HS256 (symmetric HMAC). Extension does not verify — only our backend mints and verifies, so asymmetric is unnecessary and costlier.
- Key ring: `EXT_JWT_KEYS` is a JSON object mapping `kid → base64-encoded key bytes (≥32 bytes = 256 bits)`. `EXT_JWT_CURRENT_KID` names the signing key. Verify accepts any key in the ring. Future rotation: add a new kid, flip `EXT_JWT_CURRENT_KID`, leave old kids in the ring for one TTL window, then remove.
- TTL: 8 hours (spec § Authentication — "short-lived JWT ... 8h TTL").
- Payload: `{ sub: user_id, iat, exp, kid (as protected header) }`.
- Issuer claim: `transcript-eval` so we can tell these apart from Supabase JWTs if a future route ever accepts either.

- [ ] **Step 1: Generate a development signing key**

```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'
```

Expected: a 44-character base64 string ending in `=`. Keep this string for the next step.

- [ ] **Step 2: Add env vars to `.env`**

Append to `/Users/laurynas/Desktop/one last /transcript-eval/.env` (create if missing; don't commit .env):

```bash
# Extension JWT signing (rotate by adding new kid + flipping CURRENT_KID)
EXT_JWT_CURRENT_KID=k1
EXT_JWT_KEYS={"k1":"<paste the base64 from Step 1>"}

# Freepik API (used by POST /api/freepik-url; optional at boot, lazy-checked per request)
FREEPIK_API_KEY=
```

Then create or update `.env.example` (this file IS committed — template only, no real secrets):

```bash
EXT_JWT_CURRENT_KID=k1
EXT_JWT_KEYS={"k1":"<base64-256bit-key>"}
FREEPIK_API_KEY=<optional>
```

- [ ] **Step 3: Create `server/services/ext-jwt.js`**

```javascript
// Extension JWT mint + verify (HS256, key ring indexed by kid).
// Web app calls mintExtToken(userId) after Supabase auth; extension
// stores the token in chrome.storage.local and sends it as
// Authorization: Bearer <token> on /api/export-events and
// /api/<source>-url. Rotation: add new entry to EXT_JWT_KEYS, flip
// EXT_JWT_CURRENT_KID; in-flight tokens keep working until their
// exp, because verify tries every key in the ring.

import { SignJWT, jwtVerify } from 'jose'

const ISSUER = 'transcript-eval'
const AUDIENCE = 'transcript-eval-ext'
const TTL_SECONDS = 8 * 60 * 60  // 8h

let ringCache = null
let currentKidCache = null

function loadRing() {
  if (ringCache) return ringCache
  const raw = process.env.EXT_JWT_KEYS
  if (!raw) throw new Error('EXT_JWT_KEYS env var is not set')
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('EXT_JWT_KEYS must be JSON') }
  const ring = {}
  for (const [kid, b64] of Object.entries(parsed)) {
    const bytes = Buffer.from(b64, 'base64')
    if (bytes.length < 32) throw new Error(`EXT_JWT_KEYS.${kid} must be ≥32 bytes of base64-encoded key material`)
    ring[kid] = new Uint8Array(bytes)
  }
  if (!Object.keys(ring).length) throw new Error('EXT_JWT_KEYS is empty')
  const currentKid = process.env.EXT_JWT_CURRENT_KID
  if (!currentKid) throw new Error('EXT_JWT_CURRENT_KID env var is not set')
  if (!ring[currentKid]) throw new Error(`EXT_JWT_CURRENT_KID=${currentKid} has no matching entry in EXT_JWT_KEYS`)
  ringCache = ring
  currentKidCache = currentKid
  return ring
}

export async function mintExtToken(userId) {
  if (!userId) throw new Error('userId required')
  const ring = loadRing()
  const kid = currentKidCache
  const key = ring[kid]
  const nowSec = Math.floor(Date.now() / 1000)
  const exp = nowSec + TTL_SECONDS
  const token = await new SignJWT({ sub: String(userId) })
    .setProtectedHeader({ alg: 'HS256', kid, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(nowSec)
    .setExpirationTime(exp)
    .sign(key)
  return { token, kid, user_id: String(userId), expires_at: exp * 1000 }
}

export async function verifyExtToken(token) {
  if (!token) throw new Error('token required')
  const ring = loadRing()
  // Peek at header to pick the right key without parsing the body twice
  const headerB64 = token.split('.')[0] || ''
  let header
  try { header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8')) } catch { throw new Error('malformed token') }
  const kid = header.kid
  if (!kid || !ring[kid]) throw new Error('unknown kid')
  const { payload } = await jwtVerify(token, ring[kid], { issuer: ISSUER, audience: AUDIENCE })
  return { userId: payload.sub, payload, kid }
}

// Express middleware. Attaches req.ext = { userId, payload, kid }
// on success, otherwise responds 401.
export async function requireExtAuth(req, res, next) {
  const header = req.headers.authorization || ''
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' })
  }
  try {
    req.ext = await verifyExtToken(token)
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', detail: err.message })
  }
}
```

- [ ] **Step 4: Smoke-test mint/verify round trip via node REPL**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
set -a && source .env && set +a
node -e '
import("./server/services/ext-jwt.js").then(async ({ mintExtToken, verifyExtToken }) => {
  const minted = await mintExtToken("user-abc");
  console.log("minted:", { kid: minted.kid, user_id: minted.user_id, expires_at: minted.expires_at });
  if (!minted.token.split(".").length === 3) throw new Error("not a JWT");
  const verified = await verifyExtToken(minted.token);
  if (verified.userId !== "user-abc") throw new Error("sub mismatch");
  if (verified.kid !== minted.kid) throw new Error("kid mismatch");
  // tamper check
  const bad = minted.token.slice(0, -4) + "XXXX";
  try { await verifyExtToken(bad); throw new Error("tampered token verified!"); } catch (e) { console.log("tamper rejected:", e.message); }
  // unknown kid check
  try { await verifyExtToken("eyJhbGciOiJIUzI1NiIsImtpZCI6ImJvZ3VzIiwidHlwIjoiSldUIn0.e30.xxxxx"); throw new Error("unknown kid verified!"); } catch (e) { console.log("unknown-kid rejected:", e.message); }
  console.log("OK");
});
'
```

Expected: lines showing the minted payload, a tamper-rejection line, an unknown-kid-rejection line, and `OK`. Any error throws nonzero.

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/services/ext-jwt.js .env.example
git commit -m "$(cat <<'EOF'
feat(auth): add extension JWT mint/verify service (HS256, keyed ring)

Rotation-ready from day 1: EXT_JWT_KEYS is a JSON ring indexed by
kid, EXT_JWT_CURRENT_KID names the signer, verify walks the ring.
HS256 is sufficient because our backend is both issuer and verifier
— no asymmetric cost needed. Middleware requireExtAuth attaches
req.ext for downstream handlers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `exports` router skeleton + `POST /api/exports`

**Files:**
- Create: `server/routes/exports.js`
- Modify: `server/index.js:13-55`

**Endpoint contract:**
```
POST /api/exports
Auth: Supabase JWT (requireAuth)
Body: {
  plan_pipeline_id: string,             // required
  variant_labels:   string[],           // required, e.g. ["C"] or ["A","B","C"]
  manifest:         object              // required, free-form per-item manifest
}
Response 201: { export_id, created_at }
Response 400: { error }
```

Web app calls this right before `chrome.runtime.sendMessage(EXT_ID, { type:"export", ... })` so the manifest sent to the extension carries a real `export_id` that subsequent events can reference.

- [ ] **Step 1: Add `createExport` to `server/services/exports.js`**

Open `server/services/exports.js` and append after `mintExportId()`:

```javascript
export async function createExport({ userId, planPipelineId, variantLabels, manifest }) {
  if (!planPipelineId) throw new Error('plan_pipeline_id required')
  if (!Array.isArray(variantLabels) || variantLabels.length === 0) throw new Error('variant_labels must be a non-empty array')
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest must be an object')

  const id = mintExportId()
  const manifestJson = JSON.stringify(manifest)
  const variantJson = JSON.stringify(variantLabels)

  await db.prepare(
    `INSERT INTO exports (id, user_id, plan_pipeline_id, variant_labels, status, manifest_json) VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(id, userId || null, String(planPipelineId), variantJson, manifestJson)

  const row = await db.prepare('SELECT id, created_at FROM exports WHERE id = ?').get(id)
  return { export_id: row.id, created_at: row.created_at }
}

export async function getExport(id, { userId } = {}) {
  const row = await db.prepare('SELECT * FROM exports WHERE id = ?').get(id)
  if (!row) return null
  if (userId && row.user_id && row.user_id !== userId) return null   // no leaking across users
  return row
}
```

- [ ] **Step 2: Create `server/routes/exports.js`**

```javascript
import { Router } from 'express'
import { requireAuth } from '../auth.js'
import { createExport } from '../services/exports.js'

const router = Router()

router.post('/', requireAuth, async (req, res) => {
  try {
    const { plan_pipeline_id, variant_labels, manifest } = req.body || {}
    const result = await createExport({
      userId: req.auth?.userId || null,
      planPipelineId: plan_pipeline_id,
      variantLabels: variant_labels,
      manifest,
    })
    res.status(201).json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

export default router
```

- [ ] **Step 3: Wire the router in `server/index.js`**

Add the import near the other route imports (after line 13):

```javascript
import exportsRouter from './routes/exports.js'
```

Register it where other routers are registered (after line 55):

```javascript
app.use('/api/exports', exportsRouter)
```

- [ ] **Step 4: Restart dev server**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
pkill -f "server/index.js" 2>/dev/null; sleep 1
node --env-file=.env server/index.js > /tmp/te-server.log 2>&1 &
sleep 2
grep -E "running|error" /tmp/te-server.log | head
```

Expected: `Transcript Eval API running on http://localhost:3001`, no error lines. Leave server running in the background for the remaining task.

- [ ] **Step 5: Curl test — happy path**

```bash
curl -s -X POST http://localhost:3001/api/exports \
  -H "Content-Type: application/json" \
  -H "X-Dev-Bypass: true" \
  -d '{
    "plan_pipeline_id": "test-pipeline-1",
    "variant_labels": ["C"],
    "manifest": { "items": [{"seq":1,"source":"pexels","source_item_id":"123"}] }
  }'
```

Expected: `{"export_id":"exp_01J...","created_at":"2026-04-23T..."}` with a freshly-minted ULID.

- [ ] **Step 6: Curl test — validation errors**

```bash
# Missing plan_pipeline_id
curl -s -X POST http://localhost:3001/api/exports \
  -H "Content-Type: application/json" -H "X-Dev-Bypass: true" \
  -d '{"variant_labels":["C"],"manifest":{}}'
echo

# Empty variant_labels
curl -s -X POST http://localhost:3001/api/exports \
  -H "Content-Type: application/json" -H "X-Dev-Bypass: true" \
  -d '{"plan_pipeline_id":"p","variant_labels":[],"manifest":{}}'
echo

# Unauthenticated (no dev-bypass header)
curl -s -X POST http://localhost:3001/api/exports \
  -H "Content-Type: application/json" \
  -d '{"plan_pipeline_id":"p","variant_labels":["C"],"manifest":{}}'
echo
```

Expected, in order:
```
{"error":"plan_pipeline_id required"}
{"error":"variant_labels must be a non-empty array"}
{"error":"Authentication required"}
```

- [ ] **Step 7: Confirm row landed in DB**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
set -a && source .env && set +a
node -e '
import("pg").then(async ({default: pg}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}, max: 1 });
  const r = await pool.query("SELECT id, user_id, plan_pipeline_id, variant_labels, status, manifest_json FROM exports ORDER BY created_at DESC LIMIT 1");
  console.log(r.rows[0]);
  await pool.end();
});
'
```

Expected: one row, `status: 'pending'`, `user_id: 'dev'` (dev-bypass value), `plan_pipeline_id: 'test-pipeline-1'`, `variant_labels: '["C"]'`.

- [ ] **Step 8: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/services/exports.js server/routes/exports.js server/index.js
git commit -m "$(cat <<'EOF'
feat(api): POST /api/exports — create export record

Web app calls this when user clicks Start Export, then passes the
returned export_id to the Chrome extension via postMessage so all
subsequent events + status updates reference a real row.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `POST /api/session-token`

**Files:**
- Modify: `server/routes/exports.js`

**Endpoint contract:**
```
POST /api/session-token
Auth: Supabase JWT (requireAuth)
Body: (none)
Response 200: { token, user_id, expires_at, kid }
```

Web app calls this on first export and stashes the result, then forwards `{token, user_id, expires_at}` to the extension via `chrome.runtime.sendMessage`. `kid` is exposed so admin tooling can tie tokens back to a signing key.

- [ ] **Step 1: Add a dedicated router for `/api/session-token` in `server/routes/exports.js`**

`/api/session-token` is a distinct mount point (not a sub-path of `/api/exports`), so we export a second small router instead of rewriting URLs. Add the import near the top of the file:

```javascript
import { mintExtToken } from '../services/ext-jwt.js'
```

Insert the new router above the existing `export default router` line:

```javascript
export const sessionTokenRouter = Router()
sessionTokenRouter.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.auth?.userId
    if (!userId) return res.status(401).json({ error: 'Authentication required' })
    const result = await mintExtToken(userId)
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 2: Wire the new mount in `server/index.js`**

Change the existing import line to also pull the named export:

```javascript
import exportsRouter, { sessionTokenRouter } from './routes/exports.js'
```

Add the mount immediately after `app.use('/api/exports', exportsRouter)`:

```javascript
app.use('/api/session-token', sessionTokenRouter)
```

- [ ] **Step 3: Restart dev server**

```bash
pkill -f "server/index.js" 2>/dev/null; sleep 1
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node --env-file=.env server/index.js > /tmp/te-server.log 2>&1 &
sleep 2
grep -E "running|error" /tmp/te-server.log | head
```

Expected: `running` line, no errors.

- [ ] **Step 4: Curl test**

```bash
curl -s -X POST http://localhost:3001/api/session-token \
  -H "Content-Type: application/json" \
  -H "X-Dev-Bypass: true"
```

Expected: JSON with `token` (long 3-part JWT), `user_id: "dev"`, `expires_at` (epoch_ms about 8h in the future), `kid: "k1"`.

Sanity check: decode the token header without verifying:

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/session-token -H "X-Dev-Bypass: true" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
echo "$TOKEN" | cut -d. -f1 | base64 -d 2>/dev/null
echo
echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null
```

Expected header: `{"alg":"HS256","kid":"k1","typ":"JWT"}`. Expected payload: `{"sub":"dev","iss":"transcript-eval","aud":"transcript-eval-ext","iat":...,"exp":...}`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/routes/exports.js server/index.js
git commit -m "$(cat <<'EOF'
feat(api): POST /api/session-token — mint extension JWT for the web app

Web app fetches one of these the first time a user clicks Export and
passes {token, user_id, expires_at} to the Chrome extension via
postMessage. The extension uses it as Authorization: Bearer on
/api/export-events and /api/<source>-url.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `POST /api/export-events`

**Files:**
- Modify: `server/services/exports.js`
- Modify: `server/routes/exports.js`

**Endpoint contract:**
```
POST /api/export-events
Auth: Extension JWT (requireExtAuth)
Body: {
  export_id:   string,               // required, must exist + belong to this user
  event:       string,               // one of: export_started, item_resolved, item_licensed,
                                      //          item_downloaded, item_failed, rate_limit_hit,
                                      //          session_expired, queue_paused, queue_resumed,
                                      //          export_completed
  item_id?:    string,
  source?:     string,
  phase?:      string,
  error_code?: string,
  http_status?: number,
  retry_count?: number,
  meta?:       object,               // max 4 KB when JSON-stringified (reject bigger)
  t:           number                // client epoch_ms
}
Response 202: { ok: true }          // accepted (fire-and-forget semantics for extension)
Response 4xx: { error }
```

Side effects:
1. Insert row into `export_events`.
2. On `event === 'export_started'`: `UPDATE exports SET status='in_progress' WHERE id=...`.
3. On `event === 'export_completed'`: `UPDATE exports SET status=<complete|partial|failed>, completed_at=NOW(), result_json=<meta.result_json if present>`.
4. Slack alerts — in-process dedupe window of 60s keyed on `(user_id, event, error_code)`:
   - `item_failed` when `error_code` in `{envato_403, envato_429}`
   - any `session_expired`
   - `export_completed` with `meta.fail_count ≥ 10`

**Allowed events set** — enforced because the schema doesn't have a CHECK constraint on event (would bloat migrations as events evolve). Service-level validation keeps the set canonical.

- [ ] **Step 1: Append handler logic to `server/services/exports.js`**

Append after the existing `getExport` function:

```javascript
const ALLOWED_EVENTS = new Set([
  'export_started', 'item_resolved', 'item_licensed', 'item_downloaded',
  'item_failed', 'rate_limit_hit', 'session_expired',
  'queue_paused', 'queue_resumed', 'export_completed',
])

const META_MAX_BYTES = 4096

// In-process Slack dedupe: key → lastFiredEpochMs. 60s window.
const slackLastFired = new Map()
const SLACK_DEDUPE_MS = 60_000

function maybeSlackAlert(evt, userId) {
  let title = null
  if (evt.event === 'item_failed' && (evt.error_code === 'envato_403' || evt.error_code === 'envato_429')) {
    title = `Envato ${evt.error_code} on item ${evt.item_id || '?'}`
  } else if (evt.event === 'session_expired') {
    title = 'Envato session expired mid-run'
  } else if (evt.event === 'export_completed') {
    const failCount = evt.meta && typeof evt.meta.fail_count === 'number' ? evt.meta.fail_count : 0
    if (failCount >= 10) title = `Export completed with ${failCount} failures`
  }
  if (!title) return

  const key = `${userId || 'anon'}|${evt.event}|${evt.error_code || ''}`
  const now = Date.now()
  const last = slackLastFired.get(key) || 0
  if (now - last < SLACK_DEDUPE_MS) return
  slackLastFired.set(key, now)

  notify({
    source: 'broll-export',
    title,
    meta: {
      export_id: evt.export_id,
      user_id: userId || null,
      source: evt.source || null,
      http_status: evt.http_status || null,
      retry_count: evt.retry_count || null,
    },
  })
}

export async function recordExportEvent({ userId, body }) {
  if (!body || typeof body !== 'object') throw new Error('body required')
  const { export_id, event, item_id, source, phase, error_code, http_status, retry_count, meta, t } = body

  if (!export_id) throw new Error('export_id required')
  if (!event || !ALLOWED_EVENTS.has(event)) throw new Error(`unknown event: ${event}`)
  if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error('t must be a finite number (epoch_ms)')

  let metaJson = null
  if (meta != null) {
    if (typeof meta !== 'object') throw new Error('meta must be an object')
    metaJson = JSON.stringify(meta)
    if (Buffer.byteLength(metaJson, 'utf8') > META_MAX_BYTES) throw new Error('meta too large (max 4 KB)')
  }

  // Ownership check: the export must exist and belong to this user.
  const row = await db.prepare('SELECT id, user_id, status FROM exports WHERE id = ?').get(export_id)
  if (!row) throw new Error('export_id not found')
  if (userId && row.user_id && row.user_id !== userId) throw new Error('export_id not owned by caller')

  const receivedAt = Date.now()
  await db.prepare(
    `INSERT INTO export_events (export_id, user_id, event, item_id, source, phase, error_code, http_status, retry_count, meta_json, t, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(export_id, userId || null, event, item_id || null, source || null, phase || null, error_code || null,
        http_status || null, retry_count || null, metaJson, t, receivedAt)

  // Status transitions
  if (event === 'export_started' && row.status === 'pending') {
    await db.prepare(`UPDATE exports SET status = 'in_progress' WHERE id = ?`).run(export_id)
  } else if (event === 'export_completed') {
    const failCount = meta && typeof meta.fail_count === 'number' ? meta.fail_count : 0
    const okCount = meta && typeof meta.ok_count === 'number' ? meta.ok_count : 0
    const totalCount = okCount + failCount
    let status
    if (failCount === 0) status = 'complete'
    else if (okCount === 0 || totalCount === 0) status = 'failed'
    else status = 'partial'
    const resultJson = meta ? JSON.stringify(meta) : null
    await db.prepare(`UPDATE exports SET status = ?, completed_at = NOW(), result_json = COALESCE(?, result_json) WHERE id = ?`)
      .run(status, resultJson, export_id)
  }

  // Side-effect: Slack (dedupe window of 60s per user+event+error_code).
  maybeSlackAlert({ ...body, export_id }, userId)
}
```

- [ ] **Step 2: Add the route handler**

Edit `server/routes/exports.js`. Add imports near the top:

```javascript
import { requireExtAuth } from '../services/ext-jwt.js'
import { recordExportEvent } from '../services/exports.js'
```

(Adjust the `createExport` import to be from the same module: `import { createExport, recordExportEvent } from '../services/exports.js'`.)

Add a third exported router below `sessionTokenRouter`:

```javascript
export const exportEventsRouter = Router()
exportEventsRouter.post('/', requireExtAuth, async (req, res) => {
  try {
    await recordExportEvent({ userId: req.ext?.userId || null, body: req.body })
    res.status(202).json({ ok: true })
  } catch (err) {
    const code = /not found|not owned/.test(err.message) ? 404
               : /required|must be|unknown|too large/.test(err.message) ? 400
               : 500
    res.status(code).json({ error: err.message })
  }
})
```

Wire it in `server/index.js`: change the import to `import exportsRouter, { sessionTokenRouter, exportEventsRouter } from './routes/exports.js'` and add `app.use('/api/export-events', exportEventsRouter)` below the other exports mounts.

- [ ] **Step 3: Restart dev server**

```bash
pkill -f "server/index.js" 2>/dev/null; sleep 1
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node --env-file=.env server/index.js > /tmp/te-server.log 2>&1 &
sleep 2
grep -E "running|error" /tmp/te-server.log | head
```

Expected: `running` line, no errors.

- [ ] **Step 4: Curl test — end-to-end**

```bash
# 1. Mint a session token (reuses the existing dev user)
TOKEN=$(curl -s -X POST http://localhost:3001/api/session-token \
  -H "X-Dev-Bypass: true" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
echo "token ok: ${TOKEN:0:30}..."

# 2. Create an export
EXPORT_ID=$(curl -s -X POST http://localhost:3001/api/exports \
  -H "Content-Type: application/json" -H "X-Dev-Bypass: true" \
  -d '{"plan_pipeline_id":"pp1","variant_labels":["C"],"manifest":{"items":[]}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['export_id'])")
echo "export_id: $EXPORT_ID"

# 3. Post export_started — should flip status to in_progress
T_NOW=$(node -e 'console.log(Date.now())')
curl -s -X POST http://localhost:3001/api/export-events \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"export_id\":\"$EXPORT_ID\",\"event\":\"export_started\",\"t\":$T_NOW,\"meta\":{\"total_items\":3}}"
echo

# 4. Post two item_downloaded events
T1=$(node -e 'console.log(Date.now())')
curl -s -X POST http://localhost:3001/api/export-events \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"export_id\":\"$EXPORT_ID\",\"event\":\"item_downloaded\",\"item_id\":\"001\",\"source\":\"pexels\",\"t\":$T1}"
echo

# 5. Post export_completed with ok_count=3, fail_count=0 → status=complete
T2=$(node -e 'console.log(Date.now())')
curl -s -X POST http://localhost:3001/api/export-events \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"export_id\":\"$EXPORT_ID\",\"event\":\"export_completed\",\"t\":$T2,\"meta\":{\"ok_count\":3,\"fail_count\":0,\"wall_seconds\":45}}"
echo
```

Expected: each call returns `{"ok":true}`.

- [ ] **Step 5: Verify DB state**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
set -a && source .env && set +a
node -e '
import("pg").then(async ({default: pg}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}, max: 1 });
  const exp = await pool.query("SELECT id, status, completed_at, result_json FROM exports ORDER BY created_at DESC LIMIT 1");
  console.log("export:", exp.rows[0]);
  const evs = await pool.query("SELECT event, item_id, source FROM export_events WHERE export_id = $1 ORDER BY t", [exp.rows[0].id]);
  console.log("events:", evs.rows);
  await pool.end();
});
'
```

Expected: the latest export has `status: 'complete'`, a non-null `completed_at`, and `result_json` populated; events list contains `export_started`, `item_downloaded`, `export_completed` in that order.

- [ ] **Step 6: Curl test — rejection paths**

```bash
# Unknown event
TOKEN=$(curl -s -X POST http://localhost:3001/api/session-token -H "X-Dev-Bypass: true" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
curl -s -X POST http://localhost:3001/api/export-events \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"export_id":"exp_fakeID","event":"bogus_event","t":1}' | python3 -m json.tool
# Expect: 400, "unknown event: bogus_event"

# Unknown export_id
curl -s -X POST http://localhost:3001/api/export-events \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"export_id":"exp_DOESNOTEXIST000000000000","event":"export_started","t":1}' | python3 -m json.tool
# Expect: 404, "export_id not found"

# Missing Authorization
curl -s -X POST http://localhost:3001/api/export-events \
  -H "Content-Type: application/json" \
  -d '{"export_id":"x","event":"export_started","t":1}' | python3 -m json.tool
# Expect: 401, "Missing bearer token"

# Tampered token
curl -s -X POST http://localhost:3001/api/export-events \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer notavalidjwt" \
  -d '{"export_id":"x","event":"export_started","t":1}' | python3 -m json.tool
# Expect: 401, "Invalid or expired token"
```

Expected: each case matches the "# Expect" comment.

- [ ] **Step 7: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/services/exports.js server/routes/exports.js server/index.js
git commit -m "$(cat <<'EOF'
feat(api): POST /api/export-events — extension telemetry ingestion

Writes to export_events + flips exports.status on the lifecycle
events (started → in_progress, completed → complete/partial/failed
based on ok_count/fail_count in meta). In-process 60s dedupe on
Slack alerts for envato_403/429, session_expired, and completions
with ≥10 failures.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `POST /api/pexels-url`

**Files:**
- Modify: `server/services/pexels.js`
- Modify: `server/routes/exports.js`

**Endpoint contract:**
```
POST /api/pexels-url
Auth: Extension JWT (requireExtAuth)
Body: { item_id: string|number, preferred_resolution?: "720p"|"1080p"|"1440p"|"2160p" }
Response 200: { url, filename, size_bytes, resolution: { width, height } }
Response 404: { error } if the Pexels video_id doesn't exist
```

Pexels video objects carry a `video_files` array of `{link, quality, width, height, file_type}`. We pick the best file under or equal to the preferred height. Default `preferred_resolution = "1080p"` per the spec's manifest shape.

- [ ] **Step 1: Extend `server/services/pexels.js`**

Append at the bottom of the file (after the existing `curatedPhotos` function):

```javascript
const RESOLUTION_HEIGHT = { '720p': 720, '1080p': 1080, '1440p': 1440, '2160p': 2160 }

// Pick the best video_files entry <= preferredHeight. If none fit
// (e.g. item only has 4K), fall back to the smallest available.
export function pickBestVideoFile(video, preferredResolution = '1080p') {
  const files = Array.isArray(video?.video_files) ? video.video_files : []
  if (!files.length) return null
  const wanted = RESOLUTION_HEIGHT[preferredResolution] || 1080

  // Prefer mp4, skip HLS playlists and image thumbnails
  const mp4s = files.filter(f => (f.file_type || '').toLowerCase() === 'video/mp4' && f.link)
  const pool = mp4s.length ? mp4s : files.filter(f => f.link)
  if (!pool.length) return null

  const underOrEqual = pool.filter(f => (f.height || 0) <= wanted)
  const chosen = underOrEqual.length
    ? underOrEqual.sort((a, b) => (b.height || 0) - (a.height || 0))[0]
    : pool.sort((a, b) => (a.height || 0) - (b.height || 0))[0]
  return chosen
}

// Fetch the video from Pexels + choose the best file + derive a filename.
// Returns the shape expected by POST /api/pexels-url.
export async function getDownloadUrl(itemId, preferredResolution = '1080p') {
  const video = await getVideo(itemId)
  if (!video || !video.id) throw new Error('Pexels item not found')
  const file = pickBestVideoFile(video, preferredResolution)
  if (!file) throw new Error('Pexels item has no downloadable video files')
  const ext = (file.file_type || 'video/mp4').split('/').pop() || 'mp4'
  return {
    url: file.link,
    filename: `pexels_${video.id}.${ext}`,
    size_bytes: null,              // Pexels does not return size; extension derives from Content-Length
    resolution: { width: file.width || video.width || null, height: file.height || video.height || null },
  }
}
```

- [ ] **Step 2: Add the route handler**

Edit `server/routes/exports.js`. Extend the existing exports service import and add another one:

```javascript
import { getDownloadUrl as pexelsGetDownloadUrl, isEnabled as pexelsEnabled } from '../services/pexels.js'
```

Add a fourth router below `exportEventsRouter`:

```javascript
export const pexelsUrlRouter = Router()
pexelsUrlRouter.post('/', requireExtAuth, async (req, res) => {
  try {
    if (!pexelsEnabled()) return res.status(503).json({ error: 'Pexels is not configured' })
    const { item_id, preferred_resolution } = req.body || {}
    if (!item_id) return res.status(400).json({ error: 'item_id required' })
    const result = await pexelsGetDownloadUrl(item_id, preferred_resolution || '1080p')
    res.json(result)
  } catch (err) {
    const code = /not found/i.test(err.message) ? 404 : 400
    res.status(code).json({ error: err.message })
  }
})
```

Wire in `server/index.js`: add `pexelsUrlRouter` to the destructured import and `app.use('/api/pexels-url', pexelsUrlRouter)`.

- [ ] **Step 3: Restart and curl test**

```bash
pkill -f "server/index.js" 2>/dev/null; sleep 1
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node --env-file=.env server/index.js > /tmp/te-server.log 2>&1 &
sleep 2
grep -E "running|error" /tmp/te-server.log | head

# Real Pexels video id (Pexels's "beach waves" sample, stable on their CDN)
TOKEN=$(curl -s -X POST http://localhost:3001/api/session-token -H "X-Dev-Bypass: true" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")

curl -s -X POST http://localhost:3001/api/pexels-url \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"item_id":856971,"preferred_resolution":"1080p"}' | python3 -m json.tool
```

Expected: JSON with a `url` starting with `https://videos.pexels.com/`, a `filename` like `pexels_856971.mp4`, and a `resolution` object with `width`, `height` set. If Pexels rejects the ID or the item is gone, accept a 404 with the error message.

- [ ] **Step 4: Error-case curls**

```bash
# Missing item_id
curl -s -X POST http://localhost:3001/api/pexels-url \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{}' | python3 -m json.tool
# Expect: 400 "item_id required"

# Non-existent ID
curl -s -X POST http://localhost:3001/api/pexels-url \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"item_id":99999999999}' | python3 -m json.tool
# Expect: 404
```

- [ ] **Step 5: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/services/pexels.js server/routes/exports.js server/index.js
git commit -m "$(cat <<'EOF'
feat(api): POST /api/pexels-url — extension-facing download URL proxy

Reuses the existing Pexels service. pickBestVideoFile picks the
best mp4 <= preferred_resolution, falling back to the smallest
available when nothing fits. Filename follows the spec's naming
convention (pexels_<id>.<ext>) so downstream XMEML can reference it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `POST /api/freepik-url`

**Files:**
- Create: `server/services/freepik.js`
- Modify: `server/routes/exports.js`

**Endpoint contract:**
```
POST /api/freepik-url
Auth: Extension JWT (requireExtAuth)
Body: { item_id: string|number, format?: "mp4" }
Response 200: { url, filename, size_bytes, expires_at }
Response 503: { error } if FREEPIK_API_KEY is missing
```

Freepik's `GET /v1/videos/{id}/download` endpoint (verified by `adpunk.ssh/proxy/freepik.py`) returns a signed URL for the full-resolution file. Cost: **€0.05 per call**, billed by Freepik — this endpoint is called ONLY after the user clicks Start Export and only once per item (extension deduplicates). Never speculatively.

`expires_at` handling: Freepik's signed URL carries a `token=exp=...` query param; we can either parse that or trust Freepik's documented ~15-60 min TTL. For Phase 1 we set `expires_at = now + 15 min` conservatively; extension refetches on expiry.

- [ ] **Step 1: Create `server/services/freepik.js`**

```javascript
// Freepik API client. Phase 1 only exposes getSignedDownloadUrl,
// which invokes GET /v1/videos/:id/download — a BILLABLE call
// (€0.05 per hit at Apr 2026 rates). Never call speculatively;
// only after the user has clicked Start Export and the extension
// is about to write this file to disk.

const API_KEY = process.env.FREEPIK_API_KEY || ''
const BASE = 'https://api.freepik.com'
// Freepik signed URLs expire on the order of 15–60 min; conservatively 15.
const URL_TTL_MS = 15 * 60 * 1000

export function isEnabled() {
  return Boolean(API_KEY)
}

function extToFilename(id, format) {
  const safeFormat = (format || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4'
  return `freepik_${id}.${safeFormat}`
}

export async function getSignedDownloadUrl(itemId, format = 'mp4') {
  if (!API_KEY) throw new Error('Freepik is not configured')
  if (!itemId) throw new Error('item_id required')

  const url = `${BASE}/v1/videos/${encodeURIComponent(itemId)}/download`
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'x-freepik-api-key': API_KEY, 'Accept': 'application/json' },
  })
  const text = await resp.text()
  if (!resp.ok) {
    if (resp.status === 404) { const e = new Error('Freepik item not found'); e.status = 404; throw e }
    if (resp.status === 429) { const e = new Error('Freepik rate limit'); e.status = 429; throw e }
    throw new Error(`Freepik ${resp.status}: ${text.slice(0, 200)}`)
  }
  let data
  try { data = JSON.parse(text) } catch { throw new Error('Freepik returned non-JSON body') }

  // Freepik's download response shape (verified 2026-04-23 via proxy/freepik.py):
  // { data: { url: "https://...signed...", filename: "...", size: <bytes> } }
  const d = data.data || data
  const signedUrl = d.url || d.download_url || d.href
  if (!signedUrl) throw new Error('Freepik response had no download URL')

  return {
    url: signedUrl,
    filename: d.filename || extToFilename(itemId, format),
    size_bytes: typeof d.size === 'number' ? d.size : null,
    expires_at: Date.now() + URL_TTL_MS,
  }
}
```

- [ ] **Step 2: Add the route handler**

Edit `server/routes/exports.js`. Add the import:

```javascript
import { getSignedDownloadUrl as freepikGetSignedUrl, isEnabled as freepikEnabled } from '../services/freepik.js'
```

Add a fifth router below `pexelsUrlRouter`:

```javascript
export const freepikUrlRouter = Router()
freepikUrlRouter.post('/', requireExtAuth, async (req, res) => {
  try {
    if (!freepikEnabled()) return res.status(503).json({ error: 'Freepik is not configured' })
    const { item_id, format } = req.body || {}
    if (!item_id) return res.status(400).json({ error: 'item_id required' })
    const result = await freepikGetSignedUrl(item_id, format || 'mp4')
    res.json(result)
  } catch (err) {
    const status = err.status === 404 ? 404 : err.status === 429 ? 429 : 400
    res.status(status).json({ error: err.message })
  }
})
```

Wire in `server/index.js`: add `freepikUrlRouter` to the destructured import and `app.use('/api/freepik-url', freepikUrlRouter)`.

- [ ] **Step 3: Restart + curl test**

```bash
pkill -f "server/index.js" 2>/dev/null; sleep 1
cd "/Users/laurynas/Desktop/one last /transcript-eval"
node --env-file=.env server/index.js > /tmp/te-server.log 2>&1 &
sleep 2
grep -E "running|error" /tmp/te-server.log | head

TOKEN=$(curl -s -X POST http://localhost:3001/api/session-token -H "X-Dev-Bypass: true" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")

# Missing FREEPIK_API_KEY → 503 (if not set in .env)
curl -s -X POST http://localhost:3001/api/freepik-url \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"item_id":123}' | python3 -m json.tool
# Expect: {"error":"Freepik is not configured"} with HTTP 503 if FREEPIK_API_KEY is blank
```

Expected: without `FREEPIK_API_KEY` set in `.env`, this returns 503 — which is correct.

- [ ] **Step 4: Live Freepik test (only if key is configured)**

Skip if `FREEPIK_API_KEY` is blank. Otherwise:

```bash
# Pick any Freepik video item id you own; the adpunk.ssh search
# pipeline returns them in search_videos results. For a quick
# manual check, browse freepik.com and grab the numeric id from
# a stock-video URL.
TOKEN=$(curl -s -X POST http://localhost:3001/api/session-token -H "X-Dev-Bypass: true" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
curl -s -X POST http://localhost:3001/api/freepik-url \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"item_id":<real-freepik-id>,"format":"mp4"}' | python3 -m json.tool
```

Expected: JSON with `url` (long signed URL on `*.freepik.com` or `videocdn.cdnpk.net`), `filename` containing `freepik_<id>.mp4`, `expires_at` roughly `Date.now() + 900000`. **Note: this call costs €0.05.** Only run once per verification round.

- [ ] **Step 5: Validation path**

```bash
curl -s -X POST http://localhost:3001/api/freepik-url \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{}' | python3 -m json.tool
# Expect: 400 "item_id required" (or 503 if FREEPIK_API_KEY is blank — either is fine, the endpoint is wired)

# Missing auth
curl -s -X POST http://localhost:3001/api/freepik-url \
  -H "Content-Type: application/json" \
  -d '{"item_id":123}' | python3 -m json.tool
# Expect: 401
```

- [ ] **Step 6: Commit**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval"
git add server/services/freepik.js server/routes/exports.js server/index.js
git commit -m "$(cat <<'EOF'
feat(api): POST /api/freepik-url — extension-facing Freepik signed URL proxy

Each call invokes Freepik's billable /v1/videos/:id/download
(€0.05). Endpoint is guarded by requireExtAuth so it can only be
triggered from an active export flow. URL TTL is set conservatively
to 15 min; extension refetches on expiry.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: End-to-end smoke + handoff sanity check

**Files:** (none — verification only)

**Why separate:** Running the whole happy path after every endpoint is in place catches integration bugs (missing mount, import cycle, JSON shape mismatch) that single-endpoint curls hide.

- [ ] **Step 1: Full happy-path curl script**

Drop into a scratch terminal and run verbatim:

```bash
set -e
cd "/Users/laurynas/Desktop/one last /transcript-eval"
# Make sure the server is up
pkill -f "server/index.js" 2>/dev/null; sleep 1
node --env-file=.env server/index.js > /tmp/te-server.log 2>&1 &
sleep 2

TOKEN=$(curl -s -X POST http://localhost:3001/api/session-token -H "X-Dev-Bypass: true" | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
test -n "$TOKEN" && echo "session-token ok"

EXPORT_ID=$(curl -s -X POST http://localhost:3001/api/exports \
  -H "Content-Type: application/json" -H "X-Dev-Bypass: true" \
  -d '{"plan_pipeline_id":"smoke-1","variant_labels":["A","B","C"],"manifest":{"items":[{"seq":1,"source":"pexels","source_item_id":"856971"},{"seq":2,"source":"freepik","source_item_id":"1"}]}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['export_id'])")
echo "exports row: $EXPORT_ID"

T=$(node -e 'console.log(Date.now())')
curl -sf -X POST http://localhost:3001/api/export-events \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"export_id\":\"$EXPORT_ID\",\"event\":\"export_started\",\"t\":$T,\"meta\":{\"total_items\":2,\"total_bytes_est\":200000000}}" > /dev/null
echo "export_started ok"

T=$(node -e 'console.log(Date.now())')
curl -sf -X POST http://localhost:3001/api/export-events \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"export_id\":\"$EXPORT_ID\",\"event\":\"item_downloaded\",\"item_id\":\"856971\",\"source\":\"pexels\",\"t\":$T,\"meta\":{\"bytes\":45000000,\"download_ms\":4800}}" > /dev/null
echo "item_downloaded ok"

curl -sf -X POST http://localhost:3001/api/pexels-url \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"item_id":856971,"preferred_resolution":"1080p"}' | python3 -c "import json,sys;d=json.load(sys.stdin);assert d['url'].startswith('https://');print('pexels-url ok')"

# Freepik only if configured
if [ -n "${FREEPIK_API_KEY:-}" ]; then
  curl -sf -X POST http://localhost:3001/api/freepik-url \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d '{"item_id":"<real-id>","format":"mp4"}' > /dev/null && echo "freepik-url ok" || echo "freepik-url skipped (no real id)"
else
  echo "freepik-url skipped (FREEPIK_API_KEY blank) — returns 503 by design"
fi

T=$(node -e 'console.log(Date.now())')
curl -sf -X POST http://localhost:3001/api/export-events \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d "{\"export_id\":\"$EXPORT_ID\",\"event\":\"export_completed\",\"t\":$T,\"meta\":{\"ok_count\":2,\"fail_count\":0,\"wall_seconds\":12}}" > /dev/null
echo "export_completed ok"

set -a && source .env && set +a
EXP_ID="$EXPORT_ID" node -e '
import("pg").then(async ({default: pg}) => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}, max: 1 });
  const exp = await pool.query("SELECT id, status, completed_at FROM exports WHERE id = $1", [process.env.EXP_ID]);
  console.log("final exports row:", exp.rows);
  const evs = await pool.query("SELECT event, item_id FROM export_events WHERE export_id = $1 ORDER BY t", [process.env.EXP_ID]);
  console.log("events:", evs.rows);
  await pool.end();
});
'

echo "SMOKE OK"
```

Expected: trail of `ok` lines ending in `SMOKE OK`. Final DB dump shows `status: 'complete'`, `completed_at` non-null, and 3 events in chronological order (`export_started`, `item_downloaded`, `export_completed`).

- [ ] **Step 2: Teardown dev server**

```bash
pkill -f "server/index.js" 2>/dev/null; sleep 1
```

No commit for this task.

---

## Self-Review

**1. Spec coverage (Phase 1 only).**

| Phase 1 requirement | Covered by |
|---|---|
| `exports` table | Task 1 |
| `export_events` table | Task 1 |
| `POST /api/export-events` | Task 6 |
| `POST /api/pexels-url` | Task 7 |
| `POST /api/freepik-url` | Task 8 |
| `POST /api/session-token` (JWT mint) | Tasks 3 (mint/verify lib) + 5 (endpoint) |

Added beyond strict Phase 1: `POST /api/exports` (Tasks 4). Rationale: `POST /api/export-events` has a foreign key into `exports`, so end-to-end testing and eventual extension integration require a way to create parent rows. The alternative (lazy-create on first event) would push ordering concerns into the event writer and make event ownership checks fragile. Calling this out explicitly so the reviewer can push back if strict spec adherence is preferred.

Deferred, as intended:
- `GET /admin/exports` — Phase 9 observability
- Nightly 90-day purge job — Phase 10
- `DELETE /api/user/:id/export-events` GDPR DSAR — Phase 10
- `chrome.storage.local`-driven dedupe, UI, Fluent preview UX — later phases
- `broll_searches.results_json` schema extensions with `source`/`source_item_id`/etc — these are JSON column additions requiring no DDL change and are better landed alongside the Stage 1-3 scraper work (upstream, in adpunk.ssh repo)

**2. Placeholder scan.** No TBD, TODO, "implement later", "similar to Task N", or stubbed examples. Every code block is a complete drop-in.

**3. Type and name consistency.**
- `mintExportId()` (Task 2) used by `createExport()` (Task 4) — same name, same module.
- `requireExtAuth` (Task 3) used in Tasks 6, 7, 8 — same export, same module.
- `recordExportEvent` (Task 6) — defined and used in same module; router handler imports it explicitly.
- `getDownloadUrl` in Pexels (Task 7) vs `getSignedDownloadUrl` in Freepik (Task 8) — different names kept on purpose because Pexels URLs are permanent and Freepik's are signed/expiring. Both endpoints return shapes that share `url`, `filename`, `size_bytes`; Freepik adds `expires_at`; Pexels adds `resolution`. Shapes diverge deliberately per the spec.
- `exports` table column names (`variant_labels`, `manifest_json`, `result_json`, `xml_paths`, `folder_path`, `completed_at`) match the spec's DDL exactly with two intentional deviations flagged below.

**4. Intentional deviations from the spec's raw DDL (all noted in Task 1's design notes):**
- `exports.plan_pipeline_id` is `TEXT NOT NULL` (spec said `INTEGER`). Matches `broll_searches.plan_pipeline_id TEXT` in the existing schema — the spec's INTEGER was a drafting error.
- `exports.created_at` / `completed_at` use `TIMESTAMPTZ` (spec said `INTEGER`). Matches every other `*_at` in `schema-pg.sql` and keeps admin `ORDER BY created_at DESC` readable.
- `exports.user_id TEXT` added (not in spec's raw DDL). Needed for per-user admin queries (Phase 9) and event ownership checks in this phase.
- `export_events.t` and `export_events.received_at` kept as `BIGINT` epoch_ms (matches spec). These are event-stream timestamps from two clocks; keeping them as integers avoids timezone conversion surprises on the client.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-23-envato-export-phase1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
