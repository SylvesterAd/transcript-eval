# Ext.1 — MV3 Skeleton + JWT Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the first phase (Ext.1) of the transcript-eval Export Helper Chrome extension — a working MV3 skeleton that (a) loads unpacked with a pinned, stable extension ID, (b) accepts `{type:"ping"}` and `{type:"session"}` one-shot messages from the web app via `chrome.runtime.onMessageExternal`, (c) stores the session JWT in `chrome.storage.local`, and (d) surfaces the current connection state in the toolbar popup. No download flow, no long-lived Port, no telemetry — all of that is deferred to Ext.2+.

**Architecture:** Vanilla-JS Chrome MV3 extension living inside the transcript-eval repo at `extension/`. Service worker is the message router; JWT lifecycle (store/read/expiry-check) is in `modules/auth.js`; popup reads state-only from `chrome.storage.local`. Dev test rig is a standalone HTML page under the web app's vite dev server (port 5173) that whitelists the extension via `externally_connectable` and exercises every message type. Project convention: no unit-test framework — verification is load-unpacked + test-page smoke, matching Phase 1's curl-smoke pattern.

**Tech Stack:** Chrome MV3, vanilla JS (ES modules), `chrome.runtime.onMessageExternal`, `chrome.storage.local`, Node 20 `crypto` for the one-time RSA key generator, existing transcript-eval vite dev server (port 5173) as the test harness host.

---

## Why read this before touching code

The extension needs a **stable extension ID** before anything else works — `externally_connectable` on the extension side and the web app's `EXT_ID` constant must refer to the same ID. Chrome generates a random ID every time you load unpacked *unless* `manifest.json` contains a pinned `key` field. Task 2 generates that key once, and every subsequent task assumes the ID is stable.

The spec says this is "open question 1" — this plan resolves it by pinning the key during Ext.1 setup. Extension ID changes only if someone deletes `manifest.json`'s `key` field and regenerates, which is a conscious choice.

---

## Scope (Ext.1 only — hold the line)

### In scope

- `extension/` directory scaffold inside transcript-eval (option A).
- Pinned extension key + stable dev ID.
- `manifest.json` with **minimum** permissions for Ext.1 (`storage` only).
- Service worker that routes `{type:"ping"}` → `{type:"pong", ...}` and `{type:"session", ...}` → `{ok:true}` + persists the JWT.
- `modules/auth.js` — read/write/clear JWT via `chrome.storage.local`; expiry check.
- `config.js` — `BACKEND_URL` (dev/prod), `EXT_VERSION`, `ENV`.
- Popup (`popup.html` + `popup.css` + `popup.js`) — status rows only, click-to-open transcript-eval.
- A test page served by the web app's vite dev server that exercises the message round-trip.
- `README.md` under `extension/` with load-unpacked + regeneration instructions.

### Deferred (DO NOT add to Ext.1 — they belong to later phases)

- Envato / Pexels / Freepik download flows → Ext.2, Ext.3
- Long-lived `chrome.runtime.Port` → Ext.1 uses only one-shot messages
- Telemetry to `/api/export-events` → Ext.6
- Queue / concurrency / pause-resume → Ext.5
- Envato cookie watcher → Ext.4
- 401-refresh flow from extension → Ext.4
- Mock mode / fixtures → Ext.2+
- `/api/ext-config` fetch → Ext.9
- CI packaging → Ext.10
- Icons — omitted from Ext.1 manifest; Chrome's default puzzle-piece is fine for dev. Add branded icons in a later phase.

Fight the urge to "just add" any of the above. Ext.1 proves the wiring; Ext.2 adds the first real work.

---

## Prerequisites

- Chrome 120+ on dev machine.
- Node 20+ (already used by transcript-eval).
- User will need to load the extension unpacked manually via `chrome://extensions` (this cannot be automated).
- Phase 1 backend is **not strictly required to be running** for Ext.1 verification — the test page sends mock session tokens directly via `chrome.runtime.sendMessage` rather than calling `/api/session-token`. Phase 1 backend is needed starting at Ext.2.

Note: Path to the repo has a trailing space in "one last " — quote every path. `cd "$TE"` patterns only.

---

## File structure (Ext.1 final state)

All paths are inside the transcript-eval repo root (which I'll call `$TE`).

```
$TE/extension/
├── manifest.json                  MV3 manifest (with pinned `key` field after Task 2)
├── service_worker.js              message router — onMessageExternal dispatch
├── config.js                      BACKEND_URL, EXT_VERSION, ENV
├── popup.html                     toolbar UI markup
├── popup.css                      simple clean styles (system fonts, no framework)
├── popup.js                       popup render + click handlers
├── modules/
│   └── auth.js                    JWT storage wrappers + expiry check
├── scripts/
│   └── generate-key.mjs           one-off RSA keygen + manifest-key pinner + ID printer
├── README.md                      load-unpacked + regeneration instructions
└── .extension-id                  text file containing the derived extension ID (committed so web app code can read it deterministically; regenerated only if key changes)

$TE/src/                           (existing — transcript-eval web app source)
└── extension-test.html            test harness page served by vite at http://localhost:5173/extension-test.html

$TE/.secrets/                      (new; gitignored — see Task 0)
└── extension-private-key.pem      RSA private key from key generation; not used by Chrome, kept only as a rotation artifact
```

Why this split:
- `service_worker.js` is the top-level router — it owns message dispatch and nothing else. Business logic lives in `modules/`.
- `modules/auth.js` is the ONLY file that touches the JWT; other modules call into it. Future Ext.4 will expand this file with refresh flow — not Ext.1.
- `config.js` is loaded by both popup and SW; it stays as a sibling so both contexts can import it via `import { BACKEND_URL } from '../config.js'`.
- `scripts/generate-key.mjs` runs in Node (not in Chrome) — it's a dev tool, hence under `scripts/`.
- `.extension-id` as a plain text file is the canonical reference so the web app's test harness and future web-app constant can read it with a single `fs.readFileSync`.

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/extension-ext1` on branch `feature/extension-ext1`, branched off `main`. (NOT off `feature/envato-export-phase1` — the extension is independent and should merge cleanly regardless of when Phase 1 lands.)
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan.
- **Never kill process on port 3001.** That's the user's backend dev server. If you launch anything for testing, use a different port.
- **Commit style:** conventional commits (`feat(ext): ...`, `chore(ext): ...`). Multi-line body OK. Add the Claude co-author trailer to every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing.

---

## Task 0: Create worktree + extension scaffold + gitignores

**Files:**
- Create: `$TE/.worktrees/extension-ext1/` (worktree)
- Create: `$TE/extension/` (empty dir to start)
- Modify: `$TE/.gitignore`

- [ ] **Step 1: Create the worktree + branch**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git fetch origin main
git worktree add -b feature/extension-ext1 .worktrees/extension-ext1 main
cd ".worktrees/extension-ext1"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext1
git status
# Expected: "On branch feature/extension-ext1; nothing to commit, working tree clean"
```

- [ ] **Step 2: Verify you are on the new branch before any file changes**

```bash
git branch --show-current
# Expected: feature/extension-ext1
```

If this prints anything else, STOP and fix — don't write files into the wrong branch.

- [ ] **Step 3: Create the extension directory layout**

```bash
cd ".worktrees/extension-ext1"
mkdir -p extension/modules extension/scripts
ls extension
# Expected: modules  scripts
```

- [ ] **Step 4: Update .gitignore**

Read the existing `.gitignore` at the repo root and append these lines (preserving existing contents):

```
# Extension dev artifacts
.secrets/
extension/dist/
```

Exact edit (use the Edit tool; match existing newline style):
- `old_string`: pick the last non-blank line of the current `.gitignore` to anchor.
- `new_string`: that same last line, then a blank line, then the three lines above.

If the current `.gitignore` does not exist at the repo root (unlikely), create it with just those lines.

Do NOT ignore `extension/.extension-id` — that file is committed so the web app can reference the ID deterministically.

- [ ] **Step 5: Verify the gitignore edit**

```bash
cat .gitignore | tail -5
# Expected: the three extension lines above (and any existing trailing lines)
```

- [ ] **Step 6: Commit**

```bash
git add .gitignore extension/
git status
# Expected: .gitignore modified, extension/ (but empty, so nothing to add)
```

Since `extension/modules/` and `extension/scripts/` are empty, `git add extension/` adds nothing. That's fine for this commit; the directories will appear implicitly when later tasks add files inside them.

```bash
git commit -m "$(cat <<'EOF'
chore(ext): bootstrap extension worktree + gitignore

Scaffolds the extension directory and ignores the RSA private key
and future dist artifacts. Actual extension code lands in subsequent
tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline -1
# Expected: <sha> chore(ext): bootstrap extension worktree + gitignore
```

---

## Task 1: Minimal manifest.json (no key yet — intentional)

The manifest goes in first so Task 2's keygen script has a file to mutate. Without the `key` field the extension will load but with a random ID — Task 2 pins it.

**Files:**
- Create: `$TE/.worktrees/extension-ext1/extension/manifest.json`

- [ ] **Step 1: Write `extension/manifest.json`**

Exact content (2-space indent, final newline):

```json
{
  "manifest_version": 3,
  "name": "transcript-eval Export Helper",
  "version": "0.1.0",
  "description": "Export your transcript-eval projects to Premiere with b-rolls from your own subscription accounts.",
  "minimum_chrome_version": "120",
  "permissions": ["storage"],
  "externally_connectable": {
    "matches": [
      "http://localhost:5173/*",
      "https://transcript-eval.com/*"
    ]
  },
  "background": {
    "service_worker": "service_worker.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html"
  }
}
```

Why these choices:
- `permissions: ["storage"]` — the only Chrome permission needed in Ext.1 is `chrome.storage.local`. No downloads/tabs/cookies/webNavigation/power — those come later.
- `externally_connectable.matches` — only the web app's dev and prod origins are allowed to message the extension. Without this entry, `chrome.runtime.sendMessage(EXT_ID, …)` from the web app is blocked.
- `background.type: "module"` — lets the service worker use ES modules (`import`/`export`). Matches the rest of transcript-eval which uses `"type": "module"`.
- No `host_permissions` — Ext.1 makes no outbound HTTP calls; backend fetch support is added in Ext.2+.
- No `icons` block — Chrome's default puzzle-piece is fine for dev. Branded icons come later.

- [ ] **Step 2: Verify the file parses as valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8'))"
# Expected: no output; non-zero exit on parse error
echo "exit=$?"
# Expected: exit=0
```

- [ ] **Step 3: Commit**

```bash
git add extension/manifest.json
git commit -m "$(cat <<'EOF'
feat(ext): minimal MV3 manifest for Ext.1

storage permission only; externally_connectable for localhost:5173
and prod domain; service_worker as ES module. Key field will be
pinned by the next task so the extension ID is stable across
unpacked loads.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Key generation script — pin the extension ID

Generates an RSA-2048 keypair, base64-encodes the SPKI public key into `manifest.json`'s `key` field (which makes the extension ID stable), derives and prints the ID, and stashes the private key under `.secrets/` (gitignored) as a rotation artifact.

**Files:**
- Create: `$TE/.worktrees/extension-ext1/extension/scripts/generate-key.mjs`
- Create: `$TE/.worktrees/extension-ext1/extension/.extension-id` (written by the script)
- Modify: `$TE/.worktrees/extension-ext1/extension/manifest.json` (script adds `"key"` field)
- Modify: `$TE/.worktrees/extension-ext1/package.json` (add `ext:generate-key` script)
- Create: `$TE/.worktrees/extension-ext1/.secrets/extension-private-key.pem` (written by the script; gitignored)

- [ ] **Step 1: Write the key generator script**

Create `extension/scripts/generate-key.mjs`:

```js
// One-off RSA keygen. Pins a stable extension ID by writing the SPKI
// public key into manifest.json's `key` field. Chrome derives the
// extension ID from the key, so committing the key means the ID is
// stable across unpacked loads and across machines.
//
// Run via: npm run ext:generate-key
//
// Regenerating is destructive — it changes the extension ID and breaks
// the externally_connectable whitelist in both directions. Refuses to
// run if manifest.json already has a `key` field; delete the field
// manually if you really need to rotate.

import { generateKeyPairSync, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const EXT_ROOT = path.resolve(__dirname, '..')         // extension/
const REPO_ROOT = path.resolve(EXT_ROOT, '..')          // repo root

const MANIFEST_PATH = path.join(EXT_ROOT, 'manifest.json')
const ID_OUT_PATH = path.join(EXT_ROOT, '.extension-id')
const SECRETS_DIR = path.join(REPO_ROOT, '.secrets')
const PRIV_OUT_PATH = path.join(SECRETS_DIR, 'extension-private-key.pem')

function deriveExtensionId(pubKeyDer) {
  // Chrome: sha256(public_key_DER) -> first 16 bytes (32 hex chars)
  // -> map each hex digit 0-f to letter a-p.
  const hash = createHash('sha256').update(pubKeyDer).digest('hex').slice(0, 32)
  return hash.split('').map(c => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('')
}

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`manifest.json not found at ${MANIFEST_PATH}`)
    process.exit(1)
  }

  const manifestRaw = readFileSync(MANIFEST_PATH, 'utf-8')
  const manifest = JSON.parse(manifestRaw)

  if (manifest.key) {
    console.error('manifest.json already has a `key` field. Refusing to overwrite.')
    console.error('Rotating the key changes the extension ID and breaks externally_connectable.')
    console.error('If you really want to rotate, delete the `key` field manually and rerun.')
    process.exit(1)
  }

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const pubB64 = pubDer.toString('base64')
  const extId = deriveExtensionId(pubDer)

  manifest.key = pubB64
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n')

  mkdirSync(SECRETS_DIR, { recursive: true })
  writeFileSync(PRIV_OUT_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }))

  writeFileSync(ID_OUT_PATH, extId + '\n')

  console.log('✓ Generated extension key')
  console.log(`  Extension ID: ${extId}`)
  console.log(`  Manifest:     ${MANIFEST_PATH}`)
  console.log(`  Private key:  ${PRIV_OUT_PATH} (gitignored)`)
  console.log(`  ID file:      ${ID_OUT_PATH} (committed)`)
}

main()
```

- [ ] **Step 2: Add the npm script to `package.json`**

Read the existing `package.json` and locate the `"scripts": { ... }` block. Add `"ext:generate-key": "node extension/scripts/generate-key.mjs"` to the block.

The existing scripts block (from package.json inspection during planning) is:
```json
"scripts": {
  "dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
  "dev:client": "vite",
  "dev:server": "node --env-file=.env --watch-path=server/index.js --watch-path=server/routes --watch-path=server/services server/index.js",
  "start": "node server/index.js",
  "build": "if [ \"$RAILWAY_ENVIRONMENT\" ]; then echo 'Railway: skip frontend build'; else vite build; fi",
  "seed": "node server/seed/import-benchmark.js",
  "seed:strategies": "node server/seed/create-strategies.js"
}
```

Use Edit to add a trailing comma on `"seed:strategies"` and insert a new line:

- `old_string`: `"seed:strategies": "node server/seed/create-strategies.js"`
- `new_string`: `"seed:strategies": "node server/seed/create-strategies.js",\n    "ext:generate-key": "node extension/scripts/generate-key.mjs"`

Verify formatting by re-reading the file after the edit. JSON must remain valid.

- [ ] **Step 3: Run the script**

```bash
npm run ext:generate-key
```

Expected output (ID will differ per run):

```
✓ Generated extension key
  Extension ID: <32-char string of letters a-p>
  Manifest:     /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext1/extension/manifest.json
  Private key:  /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext1/.secrets/extension-private-key.pem (gitignored)
  ID file:      /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext1/extension/.extension-id (committed)
```

**Record the printed extension ID** — Task 6 and Task 7 need it.

- [ ] **Step 4: Verify the manifest now has a `key` field and the .extension-id file exists**

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('has key:', !!m.key, '| key length:', m.key?.length)"
# Expected: has key: true | key length: ~392 (base64 of 2048-bit SPKI DER is ~392 chars)
cat extension/.extension-id
# Expected: <32-char ID>
ls .secrets/
# Expected: extension-private-key.pem
```

- [ ] **Step 5: Verify .secrets/ is gitignored (should NOT appear in git status)**

```bash
git status --short
# Expected list should INCLUDE: extension/.extension-id, extension/manifest.json, extension/scripts/generate-key.mjs, package.json
# Expected list should NOT INCLUDE: .secrets/ or anything under it
```

If `.secrets/extension-private-key.pem` shows up in `git status`, the gitignore entry from Task 0 is wrong — fix before committing.

- [ ] **Step 6: Commit**

```bash
git add extension/scripts/generate-key.mjs extension/manifest.json extension/.extension-id package.json
git status --short
# Expected: 4 files staged; no other changes
git commit -m "$(cat <<'EOF'
feat(ext): pin stable extension ID via generated RSA key

generate-key.mjs creates an RSA-2048 keypair, base64-encodes the
SPKI public key into manifest.json's `key` field, derives the Chrome
extension ID deterministically from the public key, and writes the ID
to extension/.extension-id (committed so web app code can reference
it without re-parsing the manifest).

Private key goes to .secrets/ (gitignored) — it's not used by Chrome,
kept only as a rotation artifact.

Refuses to run if manifest.json already has a key field, since
rotating changes the ID and breaks externally_connectable in both
directions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `config.js` + `modules/auth.js`

`config.js` holds compile-time constants (no `.env` — extensions can't read env vars). `modules/auth.js` is the sole owner of JWT persistence.

**Files:**
- Create: `extension/config.js`
- Create: `extension/modules/auth.js`

- [ ] **Step 1: Write `extension/config.js`**

```js
// Compile-time extension config. Chrome extensions cannot read .env
// at runtime — config is baked in at build time. ENV = "dev" on the
// unpacked build, "prod" when packaged for the Chrome Web Store.
// Change ENV by editing this file before packaging; there's no
// build-step substitution yet (added in Ext.10).

export const EXT_VERSION = '0.1.0'
export const ENV = 'dev'  // "dev" | "prod"

export const BACKEND_URL = ENV === 'prod'
  ? 'https://backend-production-4b19.up.railway.app'
  : 'http://localhost:3001'

// Message protocol version. Bump only on breaking changes to the
// web app ↔ extension message shape. See spec § "Versioning".
export const MESSAGE_VERSION = 1
```

- [ ] **Step 2: Write `extension/modules/auth.js`**

```js
// JWT lifecycle for the extension. Storage is chrome.storage.local;
// nothing persists in service worker memory because MV3 service
// workers are terminated aggressively. Every caller reads fresh.

const STORAGE_KEY = 'jwt'

// Shape returned by POST /api/session-token and by the web app's
// {type:"session"} message:
//   { token: string, kid: string, user_id: string, expires_at: number (epoch_ms) }

export async function getJwt() {
  const { [STORAGE_KEY]: jwt } = await chrome.storage.local.get(STORAGE_KEY)
  return jwt || null
}

export async function setJwt(jwt) {
  if (!jwt || typeof jwt !== 'object') throw new Error('setJwt: jwt must be an object')
  const { token, kid, user_id, expires_at } = jwt
  if (typeof token !== 'string' || !token) throw new Error('setJwt: token must be a non-empty string')
  if (typeof kid !== 'string' || !kid) throw new Error('setJwt: kid must be a non-empty string')
  if (typeof user_id !== 'string' || !user_id) throw new Error('setJwt: user_id must be a non-empty string')
  if (typeof expires_at !== 'number' || !Number.isFinite(expires_at)) throw new Error('setJwt: expires_at must be a finite number')
  await chrome.storage.local.set({ [STORAGE_KEY]: { token, kid, user_id, expires_at } })
}

export async function clearJwt() {
  await chrome.storage.local.remove(STORAGE_KEY)
}

// True if a JWT is present AND not expired. Called by popup + SW
// to decide whether the extension is "connected" to transcript-eval.
export async function hasValidJwt() {
  const jwt = await getJwt()
  if (!jwt) return false
  return jwt.expires_at > Date.now()
}
```

Why these specific validations:
- The spec pins the four fields — we reject any message that's missing or has the wrong type. Future Ext.4 adds "within 60s of expiry → refresh" logic; Ext.1 is straight present-or-absent.
- `Number.isFinite(expires_at)` catches NaN/Infinity from JSON shenanigans.

- [ ] **Step 3: Verify both files are valid JS**

```bash
node --check extension/config.js
node --check extension/modules/auth.js
# Expected: no output; exit 0 for both
```

Note: `node --check` parses syntax but does NOT verify that `chrome.storage.local` is defined — that's a Chrome-runtime-only global. Syntactic correctness is what we're confirming here.

- [ ] **Step 4: Commit**

```bash
git add extension/config.js extension/modules/auth.js
git commit -m "$(cat <<'EOF'
feat(ext): config + JWT storage module

config.js: compile-time BACKEND_URL/EXT_VERSION/ENV constants.
modules/auth.js: get/set/clear/hasValid helpers over
chrome.storage.local; validates message shape and rejects anything
missing the four required fields (token, kid, user_id, expires_at).

Nothing cached in SW memory — MV3 terminates aggressively.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Service worker — message router

Ext.1's service worker handles exactly three message types: `ping` (status probe), `session` (JWT write), and an unknown-type fallback. Nothing else.

**Files:**
- Create: `extension/service_worker.js`

- [ ] **Step 1: Write `extension/service_worker.js`**

```js
// MV3 service worker — Ext.1 scope.
//
// Handles one-shot chrome.runtime.onMessageExternal messages from the
// web app. No Port handling yet (that comes in Ext.5 when the export
// page opens a long-lived connection).
//
// IMPORTANT: the listener must return `true` so sendResponse stays
// valid while the async handler runs. Otherwise the web app sees
// `undefined` for every reply.

import { EXT_VERSION, MESSAGE_VERSION } from './config.js'
import { getJwt, setJwt, hasValidJwt } from './modules/auth.js'

async function handlePing() {
  const jwt = await getJwt()
  return {
    type: 'pong',
    version: MESSAGE_VERSION,
    ext_version: EXT_VERSION,
    envato_session: 'missing',   // Ext.1 has no cookie watcher yet — always "missing"
    has_jwt: !!jwt && jwt.expires_at > Date.now(),
    jwt_expires_at: jwt?.expires_at ?? null,
  }
}

async function handleSession(msg) {
  const { token, kid, user_id, expires_at } = msg
  try {
    await setJwt({ token, kid, user_id, expires_at })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: 'invalid_session_shape', detail: String(err?.message || err) }
  }
}

function isSupportedVersion(v) {
  // Accept current and N-1 per spec § "Versioning". Ext.1 only knows v1.
  return v === MESSAGE_VERSION
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    if (!msg || typeof msg !== 'object') {
      sendResponse({ error: 'bad_message' })
      return
    }
    if (!isSupportedVersion(msg.version)) {
      sendResponse({ error: 'unsupported_version', supported: [MESSAGE_VERSION] })
      return
    }

    switch (msg.type) {
      case 'ping':
        sendResponse(await handlePing())
        return
      case 'session':
        sendResponse(await handleSession(msg))
        return
      default:
        sendResponse({ error: 'unknown_type', type: msg.type })
        return
    }
  })()
  return true  // keep sendResponse alive for the async handler above
})
```

Why each piece:
- `isSupportedVersion` is tiny now but gives us a hook point for Ext.2+ when v2 lands. Don't delete it.
- `envato_session: 'missing'` is a static placeholder — Ext.4 wires a real cookie watcher.
- `return true` from the listener is THE most common MV3 message bug. The comment prevents someone from "cleaning it up."
- No default/fallback `try/catch` around the outer listener — per CLAUDE conventions (trust internal code), per-handler errors are handled inline. Let uncaught runtime bugs bubble up in the SW console where they're visible.

- [ ] **Step 2: Verify syntax**

```bash
node --check extension/service_worker.js
# Expected: exit 0
```

- [ ] **Step 3: Commit**

```bash
git add extension/service_worker.js
git commit -m "$(cat <<'EOF'
feat(ext): service worker message router for ping + session

Handles chrome.runtime.onMessageExternal for Ext.1's two message
types: {type:"ping"} replies {type:"pong", version, ext_version,
envato_session, has_jwt, jwt_expires_at}; {type:"session"} writes
the JWT to chrome.storage.local and replies {ok:true}.

Version gate accepts v1 only today; hook point for v2+ is in place.

`return true` from the listener is required for async sendResponse —
that line is load-bearing; removing it silently breaks every reply.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Popup — HTML + CSS + JS

Popup shows two rows (transcript-eval, Envato) and one status line. Clicking the transcript-eval row when disconnected opens transcript-eval in a new tab. Envato row is a static "—" placeholder in Ext.1 since there's no cookie watcher yet.

**Files:**
- Create: `extension/popup.html`
- Create: `extension/popup.css`
- Create: `extension/popup.js`

- [ ] **Step 1: Write `extension/popup.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>transcript-eval Export Helper</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <header>
    <h1>transcript-eval Export Helper</h1>
    <span class="version" id="version"></span>
  </header>

  <main>
    <div class="row" id="row-te">
      <div class="row-label">transcript-eval</div>
      <div class="row-status" id="status-te">—</div>
      <div class="row-detail" id="detail-te"></div>
    </div>

    <div class="row" id="row-envato">
      <div class="row-label">Envato</div>
      <div class="row-status" id="status-envato">—</div>
      <div class="row-detail" id="detail-envato">(status added in Ext.4)</div>
    </div>
  </main>

  <footer>
    <div class="banner" id="banner"></div>
  </footer>

  <script type="module" src="popup.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `extension/popup.css`**

Keep it simple and readable per user direction. System font stack, sensible spacing, clear status colors (green = ok, amber = action needed, grey = neutral).

```css
:root {
  --bg:       #ffffff;
  --fg:       #1a1a1a;
  --muted:    #6b7280;
  --border:   #e5e7eb;
  --ok:       #16a34a;
  --warn:     #d97706;
  --banner-bg: #f3f4f6;
  --link:     #2563eb;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-size: 13px;
  color: var(--fg);
  background: var(--bg);
  width: 320px;
}

header {
  padding: 12px 14px 8px;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

header h1 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}

.version {
  font-size: 11px;
  color: var(--muted);
}

main {
  padding: 10px 14px;
}

.row {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  display: grid;
  grid-template-columns: 100px 1fr;
  grid-template-rows: auto auto;
  column-gap: 10px;
  row-gap: 2px;
  align-items: center;
}

.row:last-child {
  border-bottom: none;
}

.row-label {
  color: var(--muted);
  font-weight: 500;
}

.row-status {
  font-weight: 500;
}

.row-status.ok    { color: var(--ok); }
.row-status.warn  { color: var(--warn); }
.row-status.muted { color: var(--muted); }

.row-detail {
  grid-column: 2;
  font-size: 12px;
  color: var(--muted);
}

.row.clickable {
  cursor: pointer;
}

.row.clickable:hover {
  background: #fafafa;
}

footer {
  padding: 10px 14px 12px;
  border-top: 1px solid var(--border);
  background: var(--banner-bg);
}

.banner {
  font-size: 12px;
  color: var(--fg);
}

.banner a {
  color: var(--link);
  text-decoration: none;
}

.banner a:hover {
  text-decoration: underline;
}
```

- [ ] **Step 3: Write `extension/popup.js`**

```js
// Popup renders STATE ONLY — reads from chrome.storage.local and
// config.js, never writes. Export progress UI lives on the web app
// export page (per spec § "Popup UI").

import { EXT_VERSION, BACKEND_URL } from './config.js'
import { getJwt } from './modules/auth.js'

function setRow(rowEl, statusEl, detailEl, state) {
  statusEl.textContent = state.text
  statusEl.className = `row-status ${state.className}`
  detailEl.textContent = state.detail || ''
  if (state.onClick) {
    rowEl.classList.add('clickable')
    rowEl.onclick = state.onClick
  } else {
    rowEl.classList.remove('clickable')
    rowEl.onclick = null
  }
}

async function render() {
  document.getElementById('version').textContent = `v${EXT_VERSION}`

  const rowTe = document.getElementById('row-te')
  const statusTe = document.getElementById('status-te')
  const detailTe = document.getElementById('detail-te')

  const jwt = await getJwt()
  const connected = !!jwt && jwt.expires_at > Date.now()

  if (connected) {
    const expires = new Date(jwt.expires_at).toLocaleString()
    setRow(rowTe, statusTe, detailTe, {
      text: 'connected',
      className: 'ok',
      detail: `user ${jwt.user_id.slice(0, 8)}… · expires ${expires}`,
    })
  } else {
    setRow(rowTe, statusTe, detailTe, {
      text: 'not signed in',
      className: 'warn',
      detail: 'Click to open transcript-eval',
      onClick: () => chrome.tabs.create({ url: BACKEND_URL }),
    })
  }

  // Envato row: Ext.1 has no cookie watcher — static placeholder.
  const rowEn = document.getElementById('row-envato')
  const statusEn = document.getElementById('status-envato')
  const detailEn = document.getElementById('detail-envato')
  setRow(rowEn, statusEn, detailEn, {
    text: 'unknown',
    className: 'muted',
    detail: 'Cookie check added in Ext.4',
  })

  const banner = document.getElementById('banner')
  banner.textContent = connected
    ? 'Ready. Start an export from transcript-eval.'
    : 'Sign in at transcript-eval to continue.'
}

render()
```

Why:
- Popup is reopened from scratch every time the user clicks the toolbar icon — no persistent state, no event listeners to clean up beyond the closure on `onclick`. Calling `render()` once on module load is the whole lifecycle.
- `user_id.slice(0,8) + '…'` keeps the full UUID from overflowing the 320px popup width.
- Envato row is intentionally static so someone adding cookie logic in Ext.4 has one obvious place to wire into (`setRow(rowEn, …)`).
- The "Click to open transcript-eval" label + `chrome.tabs.create` call gives the user a one-click path to sign in. Actual auth happens on the web app; the extension has no login UI.

Note on `chrome.tabs.create`: the `tabs` permission is NOT required for `chrome.tabs.create` — any extension can open a tab via that API. We stay on `permissions: ["storage"]` only.

- [ ] **Step 4: Verify JS syntax**

```bash
node --check extension/popup.js
# Expected: exit 0
```

HTML and CSS: no linter in this repo, visual check in browser at Task 7 is the verification.

- [ ] **Step 5: Commit**

```bash
git add extension/popup.html extension/popup.css extension/popup.js
git commit -m "$(cat <<'EOF'
feat(ext): popup — status rows for transcript-eval + Envato

Renders connection state from chrome.storage.local. When not signed
in, the transcript-eval row is click-to-open at BACKEND_URL. Envato
row is a static placeholder until Ext.4 wires the cookie watcher.

Read-only surface: popup never mutates state, only reads.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Web-app test harness page

A standalone HTML page served by transcript-eval's vite dev server at `http://localhost:5173/extension-test.html`. It lets you paste the extension ID, fire `ping` / `session` / unknown-type messages, and see replies — the Ext.1 equivalent of Phase 1's curl smoke.

The page is kept in `src/` rather than `public/` only because vite serves `src/` at `/` during dev. Actually: vite dev serves files from the project root and from `public/`. To be served at `/extension-test.html`, the file lives in the project root OR in `public/`. transcript-eval's existing `index.html` sits at the project root, so we'll put the test page there too — same convention.

**Files:**
- Create: `extension-test.html` at the repo root (sibling of `index.html`)

- [ ] **Step 1: Verify where vite serves the project's own `index.html` from**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext1"
ls index.html
# Expected: index.html exists at the repo root
```

If present, the new `extension-test.html` goes next to it — vite serves both at `/`.

- [ ] **Step 2: Write `extension-test.html`**

Full contents (HTML + inline styles + inline module JS — this page is a dev tool and doesn't warrant a separate JS file):

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Extension Test Harness</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      max-width: 760px;
      margin: 40px auto;
      padding: 0 20px;
      color: #1a1a1a;
      line-height: 1.5;
    }
    h1 { font-size: 20px; }
    h2 { font-size: 15px; margin-top: 28px; }
    fieldset { border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px 16px; margin: 12px 0; }
    legend { font-weight: 600; padding: 0 6px; font-size: 13px; }
    label { display: block; font-size: 13px; margin: 6px 0 2px; color: #374151; }
    input[type="text"] { width: 100%; padding: 6px 8px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; border: 1px solid #d1d5db; border-radius: 4px; box-sizing: border-box; }
    button { padding: 6px 12px; font-size: 13px; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; cursor: pointer; margin-right: 6px; }
    button:hover { background: #f9fafb; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    pre { background: #f3f4f6; padding: 10px 12px; border-radius: 4px; font-size: 12px; overflow-x: auto; margin: 6px 0; max-height: 260px; overflow-y: auto; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .muted { color: #6b7280; font-size: 12px; }
    .status-ok { color: #16a34a; font-weight: 500; }
    .status-err { color: #dc2626; font-weight: 500; }
  </style>
</head>
<body>
  <h1>transcript-eval Export Helper — Test Harness</h1>
  <p class="muted">
    Send <code>chrome.runtime.sendMessage</code> calls to the extension and display replies.
    This page must be loaded from <code>http://localhost:5173</code> — the extension's
    <code>externally_connectable</code> entry whitelists that origin.
  </p>

  <fieldset>
    <legend>Extension ID</legend>
    <label for="ext-id">Paste the 32-char ID from <code>extension/.extension-id</code>:</label>
    <input type="text" id="ext-id" placeholder="abcdefghijklmnopqrstuvwxyzabcdef" autocomplete="off">
    <p class="muted">Saved to localStorage under <code>ext_test_id</code>.</p>
  </fieldset>

  <fieldset>
    <legend>1. Ping</legend>
    <div class="row">
      <button id="btn-ping">Send {type:"ping"}</button>
    </div>
    <pre id="out-ping">(no response yet)</pre>
  </fieldset>

  <fieldset>
    <legend>2. Session</legend>
    <div class="row">
      <button id="btn-session">Send {type:"session", token:"mock…", user_id:"mock-user-00000000-0000", expires_at: now+1h}</button>
      <button id="btn-session-expired">Send expired session (expires_at: now-1h)</button>
    </div>
    <pre id="out-session">(no response yet)</pre>
  </fieldset>

  <fieldset>
    <legend>3. Unknown type</legend>
    <div class="row">
      <button id="btn-unknown">Send {type:"noop"} — expect error</button>
      <button id="btn-bad-version">Send {type:"ping", version:99} — expect unsupported_version</button>
    </div>
    <pre id="out-unknown">(no response yet)</pre>
  </fieldset>

  <fieldset>
    <legend>4. End-to-end happy path</legend>
    <div class="row">
      <button id="btn-run-all">Run all checks</button>
      <span id="run-status"></span>
    </div>
    <pre id="out-run">(not run yet)</pre>
  </fieldset>

  <script type="module">
    const idInput = document.getElementById('ext-id')
    idInput.value = localStorage.getItem('ext_test_id') || ''
    idInput.addEventListener('input', () => {
      localStorage.setItem('ext_test_id', idInput.value.trim())
    })

    function getExtId() {
      const id = idInput.value.trim()
      if (!id || id.length !== 32 || !/^[a-p]+$/.test(id)) {
        throw new Error('Paste a valid 32-char extension ID (letters a-p only).')
      }
      return id
    }

    function send(msg) {
      return new Promise((resolve, reject) => {
        try {
          const id = getExtId()
          if (!chrome?.runtime?.sendMessage) {
            reject(new Error('chrome.runtime.sendMessage is undefined — is this page loaded in Chrome with the extension installed?'))
            return
          }
          chrome.runtime.sendMessage(id, msg, (response) => {
            const err = chrome.runtime.lastError
            if (err) {
              reject(new Error(err.message))
              return
            }
            resolve(response)
          })
        } catch (e) {
          reject(e)
        }
      })
    }

    function pretty(x) {
      try { return JSON.stringify(x, null, 2) } catch { return String(x) }
    }

    async function showResult(outId, promise) {
      const out = document.getElementById(outId)
      out.textContent = '…'
      try {
        const r = await promise
        out.textContent = pretty(r)
      } catch (e) {
        out.textContent = 'ERROR: ' + (e.message || e)
      }
    }

    document.getElementById('btn-ping').onclick = () => showResult('out-ping', send({ type: 'ping', version: 1 }))

    document.getElementById('btn-session').onclick = () => showResult('out-session', send({
      type: 'session', version: 1,
      token: 'mock.jwt.token',
      kid: 'k1',
      user_id: 'mock-user-00000000-0000',
      expires_at: Date.now() + 60 * 60 * 1000,
    }))

    document.getElementById('btn-session-expired').onclick = () => showResult('out-session', send({
      type: 'session', version: 1,
      token: 'mock.jwt.token.expired',
      kid: 'k1',
      user_id: 'mock-user-00000000-0000',
      expires_at: Date.now() - 60 * 60 * 1000,
    }))

    document.getElementById('btn-unknown').onclick = () => showResult('out-unknown', send({ type: 'noop', version: 1 }))
    document.getElementById('btn-bad-version').onclick = () => showResult('out-unknown', send({ type: 'ping', version: 99 }))

    document.getElementById('btn-run-all').onclick = async () => {
      const status = document.getElementById('run-status')
      const out = document.getElementById('out-run')
      const log = []
      let ok = true

      function check(label, cond, details) {
        log.push(`${cond ? 'PASS' : 'FAIL'} — ${label}`)
        if (details) log.push('       ' + details)
        if (!cond) ok = false
      }

      try {
        const ping1 = await send({ type: 'ping', version: 1 })
        check('initial ping returns pong', ping1?.type === 'pong', `got ${pretty(ping1)}`)
        check('ext_version present', typeof ping1?.ext_version === 'string')
        check('has_jwt is false initially', ping1?.has_jwt === false, `has_jwt=${ping1?.has_jwt}`)

        const session1 = await send({
          type: 'session', version: 1,
          token: 'mock.jwt.token',
          kid: 'k1',
          user_id: 'mock-user-00000000-0000',
          expires_at: Date.now() + 60 * 60 * 1000,
        })
        check('session returns {ok:true}', session1?.ok === true, `got ${pretty(session1)}`)

        const ping2 = await send({ type: 'ping', version: 1 })
        check('post-session ping has has_jwt=true', ping2?.has_jwt === true)
        check('post-session ping has a jwt_expires_at number', typeof ping2?.jwt_expires_at === 'number')

        const unknown = await send({ type: 'noop', version: 1 })
        check('unknown type returns error', unknown?.error === 'unknown_type')

        const badVer = await send({ type: 'ping', version: 99 })
        check('unsupported version returns error', badVer?.error === 'unsupported_version')
      } catch (e) {
        log.push('EXCEPTION: ' + (e.message || e))
        ok = false
      }

      status.textContent = ok ? 'ALL PASS' : 'FAILURES'
      status.className = ok ? 'status-ok' : 'status-err'
      out.textContent = log.join('\n')
    }
  </script>
</body>
</html>
```

- [ ] **Step 3: Sanity-check the file exists and has valid HTML-ish structure**

```bash
head -5 extension-test.html
# Expected: <!DOCTYPE html> etc.
grep -c 'document.getElementById' extension-test.html
# Expected: >= 10 (the test page has many getElementById calls)
```

- [ ] **Step 4: Commit**

```bash
git add extension-test.html
git commit -m "$(cat <<'EOF'
feat(ext): dev test harness page for chrome.runtime messages

Served by vite at http://localhost:5173/extension-test.html. Lets
you paste the extension ID (from extension/.extension-id), fire
ping / session / unknown-type messages, and see the reply inline.
"Run all checks" walks through the Ext.1 happy path and reports
PASS/FAIL — matches the curl-smoke pattern used for Phase 1
verification.

Extension ID persists in localStorage so reloading the page keeps
it. Falls back to pasting from .extension-id if missing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual load-unpacked smoke test (no commit)

This task is the full end-to-end verification. It requires a human to drive Chrome — no automation. Do not skip or shortcut; this is the Ext.1 acceptance gate.

**Prereq:** Dev server running on port 5173 in a separate terminal. The extension worktree and the web app share the same repo root, so `npm run dev:client` from inside `.worktrees/extension-ext1` serves the test page at localhost:5173.

- [ ] **Step 1: Start vite dev (user-visible terminal — do not kill anything on port 3001)**

In a new terminal:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext1"
npm install   # in case node_modules is fresh in the worktree
npm run dev:client
```

Expected output includes a line like `Local: http://localhost:5173/`.

If port 5173 is taken by another vite run, stop that one or let vite auto-pick — but update `externally_connectable` + re-run generate-key is OVERKILL. Just free 5173.

- [ ] **Step 2: Record the extension ID**

```bash
cat extension/.extension-id
```

Copy the 32-char string. You'll paste it into the test page in Step 4.

- [ ] **Step 3: Load unpacked in Chrome**

1. Open Chrome.
2. Navigate to `chrome://extensions`.
3. Top-right: toggle **Developer mode** ON.
4. Click **Load unpacked**.
5. Select the directory `/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext1/extension/` (NOT the repo root — just the `extension/` folder).
6. Confirm the extension card appears with:
   - Name: **transcript-eval Export Helper**
   - Version: **0.1.0**
   - ID: the 32-char string from Step 2 (it MUST match — if it doesn't, the `key` field in the manifest is wrong; go debug Task 2).

- [ ] **Step 4: Verify the popup in a "not signed in" state**

1. Click the extension's toolbar icon (puzzle-piece menu → pin it if needed).
2. Popup should show:
   - Header: `transcript-eval Export Helper   v0.1.0`
   - Row 1: `transcript-eval    not signed in    Click to open transcript-eval`
   - Row 2: `Envato             unknown          Cookie check added in Ext.4`
   - Banner: `Sign in at transcript-eval to continue.`
3. Click the transcript-eval row — Chrome should open a new tab to `http://localhost:3001` (the BACKEND_URL for dev).
4. Close that tab; come back to the popup.

- [ ] **Step 5: Run the test page**

1. In Chrome, open `http://localhost:5173/extension-test.html`.
2. Paste the extension ID into the input at top. (It should save to localStorage automatically on every keystroke.)
3. Click **Send {type:"ping"}**.
4. `#out-ping` should show:
   ```json
   {
     "type": "pong",
     "version": 1,
     "ext_version": "0.1.0",
     "envato_session": "missing",
     "has_jwt": false,
     "jwt_expires_at": null
   }
   ```
5. Click **Send {type:"session", …}** (the first session button).
6. `#out-session` should show `{ "ok": true }`.
7. Click **Send {type:"ping"}** again.
8. `#out-ping` should now show `has_jwt: true` and a `jwt_expires_at` ~1h from now.
9. Click the extension toolbar icon to reopen the popup.
   - Row 1 should now show: `connected    user mock-use… · expires <timestamp>`
   - Banner should show: `Ready. Start an export from transcript-eval.`
10. Click **Send expired session (expires_at: now-1h)**.
11. Click **Send {type:"ping"}** again.
12. `#out-ping` should show `has_jwt: false` (expired JWT is treated as no JWT).
13. Reopen popup → should show `not signed in` again.
14. Click **Send {type:"noop"}** — expect `{"error":"unknown_type","type":"noop"}`.
15. Click **Send {type:"ping", version:99}** — expect `{"error":"unsupported_version","supported":[1]}`.

- [ ] **Step 6: Run "all checks" automated smoke**

1. Clear any existing session first: click **Send expired session**, then close/reopen the test page if needed to reset state. (OR: click the Clear button if you added one — Ext.1 didn't; the expired session covers it.)

   Actually — for a reliable all-green run, clear the extension's storage manually once:
   - `chrome://extensions` → Export Helper → **service worker** link → DevTools console opens
   - In that console: `await chrome.storage.local.clear()`
   - Close DevTools
2. Back on the test page, click **Run all checks**.
3. `#out-run` should print exactly (modulo whitespace):
   ```
   PASS — initial ping returns pong
   PASS — ext_version present
   PASS — has_jwt is false initially
   PASS — session returns {ok:true}
   PASS — post-session ping has has_jwt=true
   PASS — post-session ping has a jwt_expires_at number
   PASS — unknown type returns error
   PASS — unsupported version returns error
   ```
4. `#run-status` shows `ALL PASS` in green.

If any check fails, debug before moving to Task 8. Common failure modes:
- `chrome.runtime.lastError: Could not establish connection` → the extension ID is wrong or `externally_connectable` doesn't include `localhost:5173/*`.
- `undefined` response → the service worker listener didn't `return true` (check Task 4).
- `has_jwt: true` on the initial ping → you didn't clear storage; redo Step 6.1.

- [ ] **Step 7: Do NOT commit anything from this task**

There are no code changes in this task — it's verification. `git status` should show no modified tracked files. If anything has changed (e.g., you edited code to debug), go back and re-land it as a proper task.

```bash
git status
# Expected: "nothing to commit, working tree clean"
```

---

## Task 8: README + final polish commit

**Files:**
- Create: `extension/README.md`

- [ ] **Step 1: Write `extension/README.md`**

```markdown
# transcript-eval Export Helper — Chrome Extension

Chrome MV3 extension that downloads licensed b-roll files during a
transcript-eval export run. Ext.1 scope: MV3 skeleton + JWT storage
+ `{type:"ping"}` / `{type:"session"}` round-trip with the web app.
Download flows arrive in Ext.2+.

See `docs/specs/2026-04-23-envato-export-extension.md` for the full
spec and `docs/superpowers/plans/2026-04-23-envato-export-extension-ext1.md`
for the Ext.1 implementation plan.

## Load unpacked (dev)

1. `cd` into this repo's root.
2. `chrome://extensions` → **Developer mode** ON → **Load unpacked**.
3. Select the `extension/` directory.
4. Confirm the ID matches `extension/.extension-id`.

## Stable extension ID

Chrome derives the extension ID from the RSA public key in
`manifest.json`'s `key` field. That key was generated once (Task 2 of
the Ext.1 plan) and committed — so every dev machine loads the
extension under the same ID. That ID is also what the web app's
`externally_connectable` whitelist matches against.

Do **not** regenerate without discussing first. Regenerating changes
the ID and breaks every place that hard-codes it (including the dev
test harness page).

If you must rotate:
1. Delete the `key` field from `manifest.json`.
2. `npm run ext:generate-key`.
3. Update the web app's `EXT_ID` constant everywhere.
4. Unpack-reload and verify the new ID.

The private key at `.secrets/extension-private-key.pem` is gitignored
and not used by Chrome — it's kept only as a rotation artifact.

## Dev test harness

`extension-test.html` at the repo root is a one-page dev tool that
sends `chrome.runtime.sendMessage` calls to the extension and shows
the replies. Load it via the repo's vite dev server:

```bash
npm run dev:client
# open http://localhost:5173/extension-test.html
```

Paste the ID from `extension/.extension-id` and click **Run all
checks** for a fast smoke test.

## File layout

```
extension/
├── manifest.json
├── service_worker.js     message router (onMessageExternal)
├── config.js             BACKEND_URL / EXT_VERSION / ENV
├── popup.html/css/js     toolbar popup (status-only)
├── modules/
│   └── auth.js           JWT storage + expiry check
└── scripts/
    └── generate-key.mjs  one-off RSA keygen + manifest key pinner
```

## Known Ext.1 limitations

- Envato cookie status is a static placeholder — cookie watcher
  lands in Ext.4.
- No telemetry to `/api/export-events` — telemetry lands in Ext.6.
- No long-lived `chrome.runtime.Port` — the export page will open one
  in Ext.5 when the queue UI is added.
- No download flows — Ext.2 (Envato) and Ext.3 (Pexels/Freepik) add
  those.
```

- [ ] **Step 2: Commit**

```bash
git add extension/README.md
git commit -m "$(cat <<'EOF'
docs(ext): README — load-unpacked, ID rotation, dev test harness

Documents the Ext.1 setup flow and explicitly warns against
regenerating the extension key without coordination, since that
breaks every externally_connectable whitelist plus the hard-coded ID
in the test harness.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Full branch review**

```bash
git log --oneline main..HEAD
# Expected: 8 commits — one per task, minus Task 7 which is verification-only.
# Tasks 0, 1, 2, 3, 4, 5, 6, 8 each produce one commit.
```

```bash
git diff main --stat
# Expected additions (approximate):
#   .gitignore                               |   4 +
#   extension-test.html                      | 200+
#   extension/.extension-id                  |   1 +
#   extension/README.md                      |  50+
#   extension/config.js                      |  15
#   extension/manifest.json                  |  20+
#   extension/modules/auth.js                |  40+
#   extension/popup.css                      |  90+
#   extension/popup.html                     |  30+
#   extension/popup.js                       |  60+
#   extension/scripts/generate-key.mjs       |  75+
#   extension/service_worker.js              |  60+
#   package.json                             |   1 +
```

If `git diff main` surfaces anything OUTSIDE the extension directory, `extension-test.html` at the root, `package.json`, or `.gitignore` — investigate. You may have accidentally modified unrelated files. Revert those before finalizing.

- [ ] **Step 4: DO NOT push**

Per user convention: `git push` requires explicit consent. This task's acceptance is "all 8 commits on the local branch, branch ready for review." Surface the branch name + last commit sha to the user; ask before pushing.

---

## Self-review against the spec

After completing Tasks 0–8, re-read `docs/specs/2026-04-23-envato-export-extension.md` § "Phased delivery" Ext.1:

> **Ext.1** — MV3 skeleton + service worker + popup stubs + JWT storage + `{type: "ping"}` round trip. No download flow yet.

Coverage check:
- MV3 skeleton → Task 1 (manifest) + Task 2 (pinned key) ✓
- Service worker → Task 4 ✓
- Popup stubs → Task 5 ✓
- JWT storage → Task 3 (auth.js) ✓
- `{type:"ping"}` round trip → Task 4 (handler) + Task 6 (test harness) + Task 7 (manual verify) ✓
- No download flow → confirmed by scope guard at top of plan ✓

Spec § "Extension JWT":
- HS256 with `kid` header, 8h TTL, `chrome.storage.local` storage, `{token, kid, user_id, expires_at}` shape ✓
- 401 refresh flow explicitly DEFERRED to Ext.4 ✓ (noted in scope)

Spec § "Web app ↔ extension messaging":
- `chrome.runtime.sendMessage` one-shot ✓
- `{type:"ping"}`, `{type:"session"}` supported ✓
- `{version}` field on every message, N / N-1 support — Ext.1 knows v1 only; hook for N-1 in place but not exercised ✓

Spec § "Versioning":
- `{ext_version}` field in `pong` ✓
- Message schema bumps documented in the spec file ✓

Open questions resolved by Ext.1:
- **OQ1 (Chrome extension ID pinning)** → resolved via `generate-key.mjs` + committed `.extension-id` (Task 2). ✓

Open questions NOT resolved (expected — not in scope):
- OQ2 (`/api/ext-config`) → Ext.9.
- OQ3 (Freepik URL TTL parsing) → Ext.3/Ext.7.
- OQ4 (Envato subscription ownership) → Ext.2.
- OQ5 (filename collision handling) → Ext.2+.
- OQ6 (devtools panel) → post-MVP.

---

## Inputs parked for Ext.11 (Chrome Web Store submission)

These are NOT used in Ext.1 — just capturing so they aren't lost when Ext.11 comes around:

- **Google Developer fee:** already paid ($5, one-time). No blocker.
- **Privacy policy URL:** https://adpunk.ai/privacy-policy (overrides the spec's `transcript-eval.com/privacy` placeholder). Entered in the Chrome Web Store listing, not in `manifest.json`.
- **Manifest short description** (already set in Task 1): `Export your transcript-eval projects to Premiere with b-rolls from your own subscription accounts.` — deliberately avoids the word "Envato" per spec § "Chrome Web Store submission" (prior extensions using that wording got DMCA-pulled).
- **Long store description + category + screenshots + promo images:** user writes at Ext.11 time inside the Google console. No pre-work required now.
- **Store listing name:** `transcript-eval Export Helper` (matches `manifest.name`).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-23-envato-export-extension-ext1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration with two-stage (spec + code) review on each task.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
