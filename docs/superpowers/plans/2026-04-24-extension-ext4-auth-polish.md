# Ext.4 — Auth Polish (Port + Cookie Watcher + Session Recovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Ext.4 of the transcript-eval Export Helper Chrome extension — the auth glue that makes the extension feel reliable across session boundaries. Introduces the FIRST real use of `chrome.runtime.Port` (`onConnectExternal`) and the FIRST use of `chrome.cookies.onChanged`. Adds: (a) a long-lived Port registry so the extension can push async `state` / `refresh_session` messages to the web app, (b) an Envato cookie watcher that keeps a `envato_session_status` flag in `chrome.storage.local` in sync with the user's `.envato.com` cookies, (c) pre-flight `download.data` session check before Ext.2's one-shot runs, (d) popup sign-in flows for both rows (transcript-eval + Envato), (e) 401-recovery hooks in `modules/envato.js` (flag + broadcast + surface) and `modules/sources.js` (retry once via Port-driven JWT refresh). No queue-pause yet (Ext.5 owns that). No retry backoff matrix (Ext.7 owns that).

**Architecture:** Ext.4 adds one new module — `extension/modules/port.js` — and expands the existing `modules/auth.js` with Envato cookie + live pre-flight + port-refresh helpers. Service worker now wires three top-level event sources: existing `onMessageExternal`, new `onConnectExternal` (via `registerPortHandler`), and new `chrome.cookies.onChanged` (via `onEnvatoSessionChange`). A single active external Port is tracked at module scope in `port.js`; broadcasting is no-op when absent. 401 recovery is split by surface: Envato 401 flags-and-surfaces (queue-pause is Ext.5); transcript-eval 401 retries once after a Port-driven `refresh_session` round-trip. Pre-flight runs as a new Phase 0 in `downloadEnvato()` before the hidden-tab resolver — if it fails, no license and no tab are spent.

**Tech Stack:** Chrome MV3 (unchanged — still vanilla ES modules), `chrome.runtime.onConnectExternal` for the Port (NEW), `chrome.cookies.onChanged` + `chrome.cookies.get` (NEW, requires `cookies` manifest permission), `chrome.action.setBadgeText` + `setBadgeBackgroundColor` for the red/clear badge indicator, existing transcript-eval vite dev server (`:5173`) for the test harness. No new npm dependencies.

---

## Why read this before touching code

Nine invariants — skim them before opening any file. They explain WHY each hook looks the way it does; mechanical changes are downstream.

1. **Port is long-lived, not one-shot.** `chrome.runtime.sendMessage` is request/response with a single reply — fire-and-forget on both sides after that. `chrome.runtime.Port` is a persistent two-way channel that stays open until either side disconnects. The web app's export page opens one when it loads (`chrome.runtime.connect(EXT_ID)`) and Chrome auto-disconnects it when the tab closes. We need Port because extensions must *initiate* messages async: "your session expired, please re-mint" or (later in Ext.5) "queue phase changed to downloading." One-shot `sendMessage` can't do that because the web app isn't holding a receiver.

2. **`onConnectExternal` gives us the Port handle.** The registration happens ONCE at SW top level. When the web app calls `chrome.runtime.connect(EXT_ID)`, our handler fires with a Port object; we stash it at module scope in `port.js`. We also wire `port.onDisconnect` to clear the stash. This means at any point in time, `getActivePort()` returns either the one live Port or `null`. Ext.4 supports a **single active port at a time**; Ext.5+ might extend this if multiple export-page tabs become a thing (unlikely per spec — "Single active run per user"). A WeakMap or Set would be overkill today; one slot is the right shape.

3. **`chrome.cookies.onChanged` fires on every cookie change on every domain.** That's a LOT of events — every web page the user visits mutates cookies. We MUST filter tightly. The filter is a two-part check: `changeInfo.cookie.domain === '.envato.com'` (or endsWith `.envato.com` to handle root-domain writes) AND `changeInfo.cookie.name in ['envato_client_id', 'elements.session.5']`. Anything else returns immediately. Adding the `cookies` permission also means users see a new install prompt string — "Read and change your cookies" — which we minimize by never writing cookies and never reading cookies outside `.envato.com`. Document this in the README.

4. **Envato 401 recovery is "flag + surface", not "pause + resume".** Ext.2's `downloadEnvato()` throws `envato_session_missing` on Phase 2 401 and the one-shot debug handler returns that as an errorCode. Ext.4 does NOT add retry logic to Envato 401. It adds: (a) set `chrome.storage.local.envato_session_status = 'missing'`, (b) broadcast `{type:"state", envato_session:"missing"}` to the Port if one is open, (c) turn the toolbar badge red, (d) still throw (so the caller hard-stops the single download). The queue-pause-and-auto-retry is Ext.5 work — it can't exist without a queue. The real recovery signal is: cookie watcher sees a new `elements.session.5` appear, clears the flag, flips the badge, broadcasts `envato_session:"ok"`. Human-in-the-loop.

5. **transcript-eval 401 recovery is Port round-trip.** Different surface. When Ext.3's `sources.js` calls `/api/pexels-url` or `/api/freepik-url` and gets a 401, that means our JWT is expired or rotated. The fix is to ask the web app to re-mint via `POST /api/session-token` and push us the new token. Ext.4's `refreshSessionViaPort()` posts `{type:"refresh_session", version:1}` over the Port, then awaits a fresh `{type:"session", ...}` inbound within 10s (resolves promise) or rejects. On resolve, `sources.js` retries the fetch once — one retry, no backoff, per spec. If no Port is open, `refreshSessionViaPort()` rejects immediately and the 401 surfaces up. This pattern is small, hard to abuse, and generalizes to any future backend endpoint.

6. **Pre-flight check is one GET before each run (Ext.2's debug_envato_one_shot, and later Ext.5's full queue).** `GET https://app.envato.com/download.data?itemUuid=<REFERENCE_UUID>&itemType=stock-video&_routes=routes/download/route` with `credentials:'include'`. The reference UUID is a well-known, publicly available Envato stock-video item (bound to an item that won't go away). 200 = session is alive, proceed. 401 = session is missing, return `envato_session_missing_preflight` WITHOUT opening the resolver tab (which costs CPU and flashes even when hidden) and WITHOUT calling Phase 2 on the real item (which would cost a license). Pre-flight DOES hit `download.data` with an itemUuid — but the reference UUID is a stable item; this still "counts" as a license commit against the user's fair-use counter by Envato's accounting. That's the documented tradeoff; it's one item per run, not per item, so it's bounded.

7. **Reference UUID stability is a real open question.** We pick a UUID from a currently-listed, long-lived Envato stock-video item (anything from the examples in the spec or from our own manual inspection). If Envato delists it, pre-flight will 404/error and (per the error-branch logic below) we treat that as `preflight_error` — NOT `session_missing`. The handler returns a distinct error code so we can rotate without mistaking a dead reference for a logged-out user. Rotation is a one-line change in `auth.js`; the constant is named and commented for exactly this rotation case.

8. **`cookies` permission is NEW in Ext.4.** Users who already have Ext.1-3 installed will see a "permissions updated" dialog at the next Chrome Web Store push — Chrome disables the extension until they approve. That's a release-management concern for Ext.11 more than for the dev flow, but it's worth flagging: we only read envato.com cookies, never write, never send cookie values to our backend. The privacy story is simple and clean; the README + Chrome Web Store listing need to reflect it.

9. **Broadcasts over Port MUST NOT contain secrets.** Port messages cross the SW/web-app boundary. The web app is our own first-party code, but the principle stands: the extension never sends `jwt.token` values, cookie values, or raw Envato session cookie names in any Port broadcast. The allowed payloads are shape/metadata only: `{type, version, envato_session:"ok"|"missing", phase, ok_count, ...}`. Anything sensitive stays inside `chrome.storage.local` and is only used within SW code.

---

## Scope (Ext.4 only — hold the line)

### In scope

- `chrome.cookies` permission in manifest; bump version 0.3.0 → 0.4.0.
- New `extension/modules/port.js` — single-active-Port registry, broadcast helper, registration of `onConnectExternal`.
- Expand `extension/modules/auth.js` with four new exports: `hasEnvatoSession()`, `checkEnvatoSessionLive()`, `onEnvatoSessionChange(handler)`, `refreshSessionViaPort()` + a `ENVATO_REFERENCE_UUID` constant.
- Service worker changes:
  - Register Port handler at top level (wires `onConnectExternal` → `port.js`).
  - Subscribe to `onEnvatoSessionChange` at top level (wires `cookies.onChanged` → storage flag + badge + Port broadcast).
  - Add inbound `{type:"session"}` handler on the Port (used by `refreshSessionViaPort()` to await fresh JWTs).
  - New debug message `{type:"debug_check_envato_session", version:1}` for the test page.
- Envato module hook — 401 branch in `getSignedDownloadUrl` now also calls a private `handle401Envato()` that writes the flag, broadcasts state, and turns the badge red. Also: pre-flight Phase 0 in `downloadEnvato()`.
- Sources module hook — 401 branch in backend URL fetchers now calls `refreshSessionViaPort()` and retries the fetch ONCE if the refresh succeeds. Throws on timeout/no-port.
- Popup — dynamic Envato row (storage flag + live cookie check; clickable → opens `https://app.envato.com/sign-in`). transcript-eval row already opens `BACKEND_URL` on click from Ext.1; add a `chrome.storage.onChanged` listener so the popup live-updates when a JWT arrives while the popup is open.
- Test page — three new fieldsets: "Port + Auth" (manual connect/disconnect + incoming log), "Session status" (storage poll + `debug_check_envato_session` button), "401 refresh simulation" (manual refresh_session over the Port).
- Manual verification task.

### Deferred (DO NOT add to Ext.4 — they belong to later phases)

- **Auto-pause-queue on 401** → Ext.5 (the queue owns pause). Ext.4 only flags + broadcasts; nothing to pause yet because Ext.2's debug handler is synchronous one-shot.
- **Full retry backoff matrix** (Retry-After, exponential backoff, jitter, 5xx tiers, 402/403 differentiation) → Ext.7. Ext.4 does ONE retry on transcript-eval 401, period.
- **Periodic re-check during long runs** — NOT in Ext.4 per spec. Only pre-flight per run. The cookie watcher reactively flags loss-of-session mid-run; that's enough.
- **Expiry-based proactive refresh** (spec § "If within 60s of expiry, push refresh_session") — NOT in Ext.4 scope. Today we only refresh reactively on 401. The proactive-refresh path is a small addition Ext.5 can layer on top.
- **Popup's actual "Ready for export" / "No auth" / active-run states** (spec § Popup UI state diagram) — Ext.4 upgrades the two existing rows only. The full state machine waits until Ext.5 has a queue concept.
- **Telemetry event `session_expired`** → Ext.6. The hook point is clearly in `handle401Envato`; Ext.6 adds the `fire('session_expired', ...)` call.
- **Multi-tab Port support** — one port slot is fine; see invariant 2.
- **Icons / badge polish** — Ext.4 uses Chrome's default + solid red text for the badge. Pretty badge graphics are post-MVP.

If you catch yourself reaching for any of the Deferred list items, stop. Ext.4 glues auth into the existing pipeline; it does NOT restructure the pipeline or introduce new state machines.

See `docs/specs/2026-04-24-export-remaining-roadmap.md` § "Ext.4 — Auth polish" and `/tmp/ext-spec.md` § "Authentication flows" for the per-phase boundary.

---

## Prerequisites

- **Ext.2 + Ext.3 code merged on their branches** (or accessible via a branch we can rebase off). If neither has merged to `main` when Ext.4 work starts, branch Ext.4 from the tip of `feature/extension-ext3-sources` so both modules exist. The plan assumes both `modules/envato.js` and `modules/sources.js` exist with their 401-throwing branches in place — Ext.4 modifies both.
- **Phase 1 backend's `/api/session-token` endpoint is live** (already shipped in Phase 1 per roadmap). The web app's export page uses it to mint a JWT and `{type:"session"}` it to the extension; Ext.4's `refreshSessionViaPort` round-trips through the same endpoint via the web app.
- **A real Envato account with an active subscription** signed in on the dev Chrome profile — same prereq as Ext.2. Pre-flight (Task 7) needs the session cookies to return 200 on the reference UUID.
- **A reference Envato item UUID** that's currently listed and stable. The plan suggests one (see Task 2 step on `ENVATO_REFERENCE_UUID`), with a rotation procedure if it disappears. The user can override by setting the constant manually.
- **Chrome 120+** (unchanged prereq). `chrome.cookies.onChanged` and `chrome.runtime.onConnectExternal` have been in MV3 since day one; no version gotcha.
- **Node 20+** (unchanged). No new npm packages in Ext.4.

Note: Path to the repo has a trailing space in `"one last "` — quote every path.

---

## File structure (Ext.4 final state)

Additions over Ext.3 are marked `[NEW Ext.4]`; modifications are `[MOD Ext.4]`.

```
$TE/extension/
├── manifest.json                  [MOD Ext.4] version 0.3.0 → 0.4.0; +"cookies" permission
├── service_worker.js              [MOD Ext.4] register port handler; subscribe to cookie watcher; new debug_check_envato_session case; onMessage-on-Port session handler
├── config.js                      (unchanged — EXT_VERSION bump happens via manifest-only bump? see Task 2)
├── popup.html                     [MOD Ext.4] Envato row gets a sign-in affordance; add id hooks for live updates
├── popup.css                      [MOD Ext.4] minor — a "sign in" button style
├── popup.js                       [MOD Ext.4] dynamic Envato row, live storage listener, sign-in click handlers
├── .extension-id                  (unchanged)
├── README.md                      [MOD Ext.4] append "Ext.4 — Auth polish" section; document cookies permission privacy posture
├── modules/
│   ├── auth.js                    [MOD Ext.4] add hasEnvatoSession / checkEnvatoSessionLive / onEnvatoSessionChange / refreshSessionViaPort / ENVATO_REFERENCE_UUID
│   ├── envato.js                  [MOD Ext.4] Phase 0 preflight; 401 path calls handle401Envato
│   ├── sources.js                 [MOD Ext.4] 401 path calls refreshSessionViaPort + retries once
│   └── port.js                    [NEW Ext.4] single-active-Port registry + broadcast helper + onConnectExternal
├── scripts/
│   └── generate-key.mjs           (unchanged)
└── fixtures/
    └── envato/
        └── .gitkeep               (unchanged)

$TE/extension-test.html            [MOD Ext.4] three new fieldsets: Port + Auth, Session status, 401 refresh simulation
```

Why this split:
- `modules/port.js` is a separate file — the Port lifecycle will grow (Ext.5 adds inbound message routing for queue control) and this is the one obvious place for that code.
- `modules/auth.js` stays the sole owner of anything auth-shaped. Envato session + transcript-eval JWT are both auth concerns; co-locating them keeps the mental model clear. Later Ext.6 (telemetry `session_expired` event) will hook from here too.
- Popup additions are small enough that no new file is needed.

---

## Working conventions for these tasks

- **Worktree:** All work happens in `$TE/.worktrees/extension-ext4` on branch `feature/extension-ext4-auth-polish`. Branch point: if Ext.3's branch (`feature/extension-ext3-sources`) has NOT merged to `main`, branch from it; otherwise branch from `main`. Task 0 handles both variants.
- **Never push.** `git commit` is fine. `git push` requires explicit user approval and is NOT part of this plan. Task 9 has an explicit "DO NOT push" reminder.
- **Never kill anything on port 3001.** User's backend dev server.
- **Commit style:** conventional commits (`feat(ext): ...`, `chore(ext): ...`, `docs(ext): ...`). Multi-line body OK. Add the Claude co-author trailer to every commit:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Quote paths with the trailing space.** `cd "/Users/laurynas/Desktop/one last /transcript-eval/"` — the space in `one last ` is load-bearing.
- **No retries beyond one.** If you find yourself writing a loop with a retry counter in Ext.4, delete it; that code belongs in Ext.7.
- **No broadcasts with sensitive data.** If the Port payload includes `jwt.token`, a cookie value, or raw headers — stop and re-read invariant 9.

---

## Task 0: Create worktree + branch

**Files:**
- Create: `$TE/.worktrees/extension-ext4/` (worktree)

- [ ] **Step 1: Decide the branch-point**

```bash
TE="/Users/laurynas/Desktop/one last /transcript-eval"
cd "$TE"
git fetch origin
git branch -a | grep extension-ext3 || echo "no ext3 branch"
git branch -a | grep extension-ext2 || echo "no ext2 branch"
```

- If `feature/extension-ext3-sources` still exists (Ext.3 not yet merged), branch FROM it — we need `modules/sources.js` in place:
  ```bash
  git worktree add -b feature/extension-ext4-auth-polish .worktrees/extension-ext4 feature/extension-ext3-sources
  ```
- If Ext.3 has merged to `main`, branch from `main`:
  ```bash
  git worktree add -b feature/extension-ext4-auth-polish .worktrees/extension-ext4 main
  ```

If ONLY Ext.2 has landed (no Ext.3), stop and coordinate — Ext.4 expects `modules/sources.js` to exist (it hooks into `sources.js`'s 401 branch). Don't forge ahead without Ext.3's code on the tree.

- [ ] **Step 2: Enter the worktree and verify**

```bash
cd "$TE/.worktrees/extension-ext4"
pwd
# Expected: /Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext4
git branch --show-current
# Expected: feature/extension-ext4-auth-polish
ls extension/modules/
# Expected: auth.js envato.js sources.js
cat extension/.extension-id
# Expected: 32-char a-p string (identical to Ext.1)
```

If `extension/modules/sources.js` is missing, Ext.3 is incomplete — stop and go fix Ext.3 before proceeding.

- [ ] **Step 3: Confirm the manifest says version `0.3.0`**

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('version:', m.version, '| permissions:', m.permissions)"
# Expected: version: 0.3.0 | permissions: [ 'storage', 'tabs', 'webNavigation', 'downloads' ]
```

If the output differs, someone has already started Ext.4 work on this branch — figure out why before continuing.

There is nothing to commit in this task — creating a worktree and branch doesn't produce a file change on its own.

---

## Task 1: Update manifest — `cookies` permission + version bump

Manifest change goes first so the runtime `chrome.cookies.*` APIs are available before `auth.js` imports them. Loading the extension with an API call that lacks its permission throws `undefined is not a function` at SW boot — confusing failure mode worth avoiding.

**Files:**
- Modify: `extension/manifest.json`

- [ ] **Step 1: Read the current manifest**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext4"
```

Open `extension/manifest.json`. It should have `permissions: ["storage", "tabs", "webNavigation", "downloads"]` from Ext.2 and a `host_permissions` array with Envato + (from Ext.3) backend origins.

- [ ] **Step 2: Bump `version` from `0.3.0` to `0.4.0`**

Use the Edit tool:
- `old_string`: `"version": "0.3.0"`
- `new_string`: `"version": "0.4.0"`

Only ONE occurrence exists, so this is unambiguous.

- [ ] **Step 3: Add `cookies` to the `permissions` array**

The exact current value depends on Ext.3's final permission list, but Ext.2 leaves it as `["storage", "tabs", "webNavigation", "downloads"]` — Ext.3 doesn't add to it per its plan. Use Edit with the Ext.3 final state as the anchor:

- `old_string`: `"permissions": ["storage", "tabs", "webNavigation", "downloads"]`
- `new_string`: `"permissions": ["storage", "tabs", "webNavigation", "downloads", "cookies"]`

If the exact string doesn't match because Ext.3 added something, adapt the old_string to the real value and append `"cookies"` at the end — order inside the array is semantic-meaningless to Chrome.

Rationale:
- `cookies` — required for `chrome.cookies.get` (pre-flight-style check to confirm session exists BEFORE hitting the network) AND for `chrome.cookies.onChanged` (the reactive cookie watcher). Without it, both API calls are `undefined`.
- No new `host_permissions` — `chrome.cookies.get({url: 'https://app.envato.com/...'})` uses a `url` param to scope access, and `https://app.envato.com/*` is already in `host_permissions` from Ext.2.

- [ ] **Step 4: Verify the manifest still parses**

```bash
node -e "const m=JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')); console.log('version:', m.version, '| permissions:', m.permissions, '| host_perms_count:', m.host_permissions.length, '| key_present:', !!m.key)"
# Expected: version: 0.4.0 | permissions: [ 'storage', 'tabs', 'webNavigation', 'downloads', 'cookies' ] | host_perms_count: 3 (or >3 if Ext.3 added any) | key_present: true
```

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json
git commit -m "$(cat <<'EOF'
feat(ext): manifest — add cookies permission for Ext.4 session watcher

Version 0.3.0 → 0.4.0. Adds "cookies" to permissions so Ext.4's
chrome.cookies.onChanged watcher (on .envato.com for the
envato_client_id and elements.session.5 cookies) + chrome.cookies.get
calls (for hasEnvatoSession) can function. host_permissions already
covered by Ext.2's https://app.envato.com/* entry.

Privacy posture: extension reads only envato.com cookies, never
writes any cookie, never sends cookie values to our backend. Cookie
state is surfaced to the user only via popup UI + optional per-session
"envato_session: ok/missing" field in Port broadcasts (no values).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Bump `EXT_VERSION` in config.js + add the reference UUID constant

Two small edits, one file and one other. Keeps auth-related constants in auth.js rather than scattering.

**Files:**
- Modify: `extension/config.js`

- [ ] **Step 1: Bump `EXT_VERSION`**

```bash
cat extension/config.js
```

Expected shape (from Ext.2): `export const EXT_VERSION = '0.2.0'` (Ext.3 may have bumped to `0.3.0` — inspect and adapt). For this plan, assume Ext.3 bumped it; if not, adjust accordingly.

Use Edit:
- `old_string`: `export const EXT_VERSION = '0.3.0'`
- `new_string`: `export const EXT_VERSION = '0.4.0'`

If the old value is `'0.2.0'` because Ext.3 didn't bump it, make the old_string match what you find on disk.

- [ ] **Step 2: Verify syntax**

```bash
node --check extension/config.js
# Expected: exit 0
```

- [ ] **Step 3: Commit**

```bash
git add extension/config.js
git commit -m "$(cat <<'EOF'
feat(ext): config — EXT_VERSION bump for Ext.4

0.3.0 → 0.4.0. Matches manifest bump; keeps popup and pong reply
showing the right string.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Expand `modules/auth.js` — Envato session helpers + Port refresh + reference UUID

This is the brains of Ext.4 — four new exports and one constant. Keep existing exports (`getJwt`, `setJwt`, `clearJwt`, `hasValidJwt`) untouched.

**Files:**
- Modify: `extension/modules/auth.js`

- [ ] **Step 1: Read current `auth.js`**

```bash
cat extension/modules/auth.js
```

Expected from Ext.1: four exports (`getJwt`, `setJwt`, `clearJwt`, `hasValidJwt`), a STORAGE_KEY constant. No imports. If Ext.2/Ext.3 added anything, note it but don't touch it.

- [ ] **Step 2: Add the reference UUID constant + new imports at the top**

Use Edit:
- `old_string`: `const STORAGE_KEY = 'jwt'`
- `new_string`:
  ```
  const STORAGE_KEY = 'jwt'

  // Envato session cookies — watched for appear/disappear transitions
  // that mean the user signed in or out. Both are required for a
  // logged-in session; either missing = no session.
  const ENVATO_COOKIE_NAMES = ['envato_client_id', 'elements.session.5']
  const ENVATO_COOKIE_DOMAIN = '.envato.com'

  // Key for the cached Envato session status in chrome.storage.local.
  // Kept across SW restarts so popup can render without blocking on a
  // fresh cookie round-trip.
  const ENVATO_STATUS_KEY = 'envato_session_status'

  // Reference Envato item UUID used for the pre-flight session check.
  // Must point to a currently-listed, long-lived stock-video item. If
  // Envato delists it, pre-flight starts returning errors even with a
  // healthy session — which we distinguish from 401 via HTTP status
  // inspection.
  //
  // Rotation procedure: pick a new stable item from
  //   https://elements.envato.com/stock-video
  // open it, look at the app.envato.com/<segment>/<UUID> URL it
  // redirects to, paste the UUID here.
  //
  // As of 2026-04: this UUID is a well-known long-lived Envato item.
  // If pre-flight starts failing with non-401 status on a healthy
  // account, rotate.
  export const ENVATO_REFERENCE_UUID = '00000000-0000-0000-0000-000000000000'
  ```

**NOTE:** the `'00000000-0000-0000-0000-000000000000'` placeholder is intentional. Task 7 calls this out explicitly: the user must substitute a real UUID before running the pre-flight verification. The plan flags this as an open question — see "Open questions" below.

- [ ] **Step 3: Add `hasEnvatoSession()`**

Append after `hasValidJwt()`. Use Edit:
- `old_string`: (whatever currently closes `hasValidJwt` — likely `}`)
  ```
  export async function hasValidJwt() {
    const jwt = await getJwt()
    if (!jwt) return false
    return jwt.expires_at > Date.now()
  }
  ```
- `new_string`:
  ```
  export async function hasValidJwt() {
    const jwt = await getJwt()
    if (!jwt) return false
    return jwt.expires_at > Date.now()
  }

  // Reads .envato.com cookies. Returns true ONLY if both
  // envato_client_id and elements.session.5 are present (name-match
  // only; we don't validate cookie value — Envato's server does that).
  export async function hasEnvatoSession() {
    const results = await Promise.all(ENVATO_COOKIE_NAMES.map(name =>
      new Promise(resolve => {
        chrome.cookies.get({ url: 'https://www.envato.com/', name }, cookie => {
          // If the cookie is set on a subdomain (e.g. app.envato.com)
          // instead of root, chrome.cookies.get still finds it via URL
          // match. Fall back to explicit app.envato.com URL if root
          // returns null.
          if (cookie) return resolve(cookie)
          chrome.cookies.get({ url: 'https://app.envato.com/', name }, c2 => resolve(c2))
        })
      })
    ))
    return results.every(c => !!c)
  }
  ```

- [ ] **Step 4: Add `checkEnvatoSessionLive()`**

Directly after `hasEnvatoSession`:

```js
// Network pre-flight: hits download.data with the reference UUID to
// confirm Envato actually recognizes the session (cookies present is
// necessary but not sufficient — Envato may have invalidated on its
// side). Returns a structured result so the caller can distinguish
// "401 — session missing" (user action needed) from "5xx / network
// error" (transient) from "reference UUID delisted" (rotate the
// constant).
export async function checkEnvatoSessionLive() {
  const url = `https://app.envato.com/download.data?itemUuid=${encodeURIComponent(ENVATO_REFERENCE_UUID)}&itemType=stock-video&_routes=routes/download/route`
  let resp
  try {
    resp = await fetch(url, { credentials: 'include' })
  } catch (err) {
    return { status: 'error', detail: String(err?.message || err) }
  }
  if (resp.status === 401) return { status: 'missing', httpStatus: 401 }
  if (resp.ok) return { status: 'ok', httpStatus: resp.status }
  return { status: 'error', httpStatus: resp.status, detail: `pre-flight HTTP ${resp.status}` }
}
```

- [ ] **Step 5: Add `onEnvatoSessionChange(handler)`**

```js
// Subscribes to chrome.cookies.onChanged, filters to envato.com +
// the two cookies we care about, calls handler({status}) when those
// cookies transition.
//
// Returns an unsubscribe function. The service worker registers ONE
// subscription at top level (in service_worker.js), so the returned
// unsubscribe is mostly for completeness / tests.
//
// The handler is called with {status:'ok'|'missing'} based on the
// CURRENT aggregate state, not the transition direction. If any
// envato cookie was just set and the OTHER is also present, status
// is 'ok'. If either is missing, status is 'missing'.
export function onEnvatoSessionChange(handler) {
  const listener = async (changeInfo) => {
    const c = changeInfo?.cookie
    if (!c) return
    // Domain match: handle both leading-dot and exact root. Chrome
    // normalizes envato-set cookies to '.envato.com' with the dot.
    const d = c.domain || ''
    const domainOk = d === ENVATO_COOKIE_DOMAIN || d === 'envato.com' || d.endsWith('.envato.com')
    if (!domainOk) return
    if (!ENVATO_COOKIE_NAMES.includes(c.name)) return
    // Re-read aggregate state (the changeInfo for one cookie doesn't
    // tell us about the other's state).
    const ok = await hasEnvatoSession()
    handler({ status: ok ? 'ok' : 'missing' })
  }
  chrome.cookies.onChanged.addListener(listener)
  return () => {
    try { chrome.cookies.onChanged.removeListener(listener) } catch {}
  }
}
```

- [ ] **Step 6: Add `refreshSessionViaPort()`**

This one imports from `port.js` (added in Task 4), so if you write this first and syntax-check, you'll hit a missing-module error. Defer commit of this function until after Task 4, OR use a lazy `await import('./port.js')` inside the function so the top-level import isn't needed.

We'll use the lazy-import pattern — it keeps `auth.js` testable in isolation and avoids circular-import hazards (port.js will eventually want to call `setJwt` on inbound sessions; dynamic import breaks the cycle).

```js
// Requests a fresh JWT from the web app via the Port. Returns a
// Promise that resolves on the next inbound {type:"session"} message
// or rejects on:
//   - no port open: 'no_port'
//   - 10s timeout: 'refresh_timeout'
//   - port disconnected mid-wait: 'port_disconnected'
//
// After resolve, the new JWT is ALREADY in chrome.storage.local (the
// SW Port onMessage handler writes it before resolving this promise).
// Callers just `await refreshSessionViaPort(); await retryOriginalFetch()`.
export async function refreshSessionViaPort() {
  const { getActivePort, waitForNextSessionMessage } = await import('./port.js')
  const port = getActivePort()
  if (!port) throw new Error('no_port')
  const waitPromise = waitForNextSessionMessage(10000)
  try {
    port.postMessage({ type: 'refresh_session', version: 1 })
  } catch (err) {
    throw new Error('port_post_failed: ' + String(err?.message || err))
  }
  return waitPromise
}
```

- [ ] **Step 7: Syntax check**

```bash
node --check extension/modules/auth.js
# Expected: exit 0
```

Again, `node --check` won't validate that `chrome.cookies.*` or `chrome.runtime.*` globals exist — that's runtime-only. Syntactic correctness is what's confirmed here.

- [ ] **Step 8: Commit**

```bash
git add extension/modules/auth.js
git commit -m "$(cat <<'EOF'
feat(ext): auth — Envato session helpers + Port refresh + reference UUID

Adds four exports + one constant to modules/auth.js:

- ENVATO_REFERENCE_UUID: placeholder; must be set to a currently-
  listed Envato stock-video item UUID. Used by checkEnvatoSessionLive
  as the pre-flight target. Rotation notes in the docstring.
- hasEnvatoSession(): reads .envato.com cookies via chrome.cookies.get,
  returns true only when both envato_client_id and elements.session.5
  are present.
- checkEnvatoSessionLive(): GET download.data?itemUuid=REFERENCE with
  credentials:'include'. Returns {status:'ok'|'missing'|'error',
  httpStatus?, detail?}. Distinguishes 401 (user signed out) from 5xx
  (transient / delisted UUID).
- onEnvatoSessionChange(handler): wraps chrome.cookies.onChanged,
  filters to .envato.com + our two cookies, calls handler with the
  post-change aggregate status. Returns an unsubscribe function.
- refreshSessionViaPort(): posts {type:"refresh_session", version:1}
  on the active Port (lazy-imported from port.js to avoid circular
  deps), awaits the next {type:"session"} inbound within 10s. Rejects
  on no_port / refresh_timeout / port_disconnected.

Existing exports (getJwt, setJwt, clearJwt, hasValidJwt) are
unchanged — Ext.4 expands, doesn't rewrite.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Create `modules/port.js` — single-active-Port registry

This is the FIRST real use of `chrome.runtime.Port` in the extension. Keep it tight — Ext.5 will add more; we lay the groundwork without over-reaching.

**Files:**
- Create: `extension/modules/port.js`

- [ ] **Step 1: Create `extension/modules/port.js`**

Exact contents:

```js
// Long-lived Port registry. ONE active port at a time — the export
// page on the web app. Ext.5 may extend this if multi-tab becomes a
// thing (spec allows a single active run per user, so multi-tab is
// unlikely).
//
// onConnectExternal fires when the web app calls
// chrome.runtime.connect(EXT_ID). We stash the port at module scope
// so any SW code path (envato.js error, sources.js refresh, cookie
// watcher state change) can call broadcastToPort() without passing
// the port around.
//
// Security: the web app's origin is checked against an allow-list
// before accepting a port. Matches externally_connectable's matches
// entry in manifest.json. A rogue page on another origin cannot
// attach.

import { setJwt } from './auth.js'

// Mirrors manifest.json externally_connectable.matches. Keep this list
// aligned with the manifest.
const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'https://transcript-eval.com',
]

// Module-scoped singletons — the Port lives here.
let activePort = null
let activeSenderUrl = null

// Pending resolvers for refreshSessionViaPort() — each call adds one;
// the next inbound {type:"session"} resolves the first; any
// disconnect rejects them all.
const pendingSessionResolvers = []

function isOriginAllowed(url) {
  try {
    const u = new URL(url)
    const origin = `${u.protocol}//${u.host}`
    return ALLOWED_ORIGINS.includes(origin)
  } catch {
    return false
  }
}

// Called by service_worker.js at top level. Wires onConnectExternal
// and dispatches inbound messages / disconnect to user handlers.
//
// onConnect / onDisconnect / onMessage callbacks are optional —
// service_worker.js uses them to log lifecycle + route
// non-auth-related inbound messages (e.g. Ext.5's queue commands).
export function registerPortHandler({ onConnect, onDisconnect, onMessage } = {}) {
  chrome.runtime.onConnectExternal.addListener((port) => {
    const senderUrl = port?.sender?.url || ''
    if (!isOriginAllowed(senderUrl)) {
      try { port.disconnect() } catch {}
      return
    }

    // If another port is already active, disconnect the old one.
    // Simpler than queuing; matches "single active run" semantics.
    if (activePort && activePort !== port) {
      try { activePort.disconnect() } catch {}
    }

    activePort = port
    activeSenderUrl = senderUrl
    onConnect?.({ port, senderUrl })

    port.onMessage.addListener(async (msg) => {
      if (!msg || typeof msg !== 'object') return
      // Auth-related inbound messages are handled HERE (centralized)
      // so other modules don't have to subscribe.
      if (msg.type === 'session') {
        const { token, kid, user_id, expires_at } = msg
        try {
          await setJwt({ token, kid, user_id, expires_at })
          // Resolve all pending refreshers.
          while (pendingSessionResolvers.length) {
            const r = pendingSessionResolvers.shift()
            r.resolve({ token, kid, user_id, expires_at })
          }
        } catch (err) {
          // Bad shape — reject pending refreshers so they don't hang.
          while (pendingSessionResolvers.length) {
            const r = pendingSessionResolvers.shift()
            r.reject(new Error('bad_session_shape: ' + String(err?.message || err)))
          }
        }
        return
      }
      onMessage?.(msg, { port, senderUrl })
    })

    port.onDisconnect.addListener(() => {
      if (activePort === port) {
        activePort = null
        activeSenderUrl = null
      }
      // Reject any still-pending refreshers; their 10s timeout would
      // have fired anyway, but this makes failure fast.
      while (pendingSessionResolvers.length) {
        const r = pendingSessionResolvers.shift()
        r.reject(new Error('port_disconnected'))
      }
      onDisconnect?.({ senderUrl })
    })
  })
}

// Returns the current active Port or null. Safe to call at any time.
// Consumers should treat null as "no export page open."
export function getActivePort() {
  if (!activePort) return null
  return { port: activePort, senderUrl: activeSenderUrl }
}

// Posts a message to the active port. No-op if no port is attached.
// Caller passes plain objects; we wrap in try/catch because Chrome
// can throw if the port is mid-disconnect.
export function broadcastToPort(msg) {
  if (!activePort) return false
  try {
    activePort.postMessage(msg)
    return true
  } catch {
    return false
  }
}

// Used by refreshSessionViaPort in auth.js. Returns a promise that
// resolves on the next inbound {type:"session"} OR rejects on the
// configured timeout (default 10s). The promise is added to
// pendingSessionResolvers; the onMessage and onDisconnect listeners
// above drain the queue.
export function waitForNextSessionMessage(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject }
    pendingSessionResolvers.push(entry)
    setTimeout(() => {
      const idx = pendingSessionResolvers.indexOf(entry)
      if (idx !== -1) {
        pendingSessionResolvers.splice(idx, 1)
        reject(new Error('refresh_timeout'))
      }
    }, timeoutMs)
  })
}
```

Design notes:
- **Single slot.** We overwrite `activePort` on a new connection; the old one is disconnected. Port-per-tab complexity lives in Ext.5 if it's ever needed.
- **Origin allow-list.** Hardcoded to the two values in `externally_connectable`. If those ever drift, the port is silently rejected — failure is safe.
- **Centralized `session` inbound.** The SW's message handler in service_worker.js doesn't need to route `{type:"session"}` on the Port; port.js handles it. This keeps auth plumbing in one place.
- **`pendingSessionResolvers` queue.** We use a queue rather than a single slot because a rare race (two near-simultaneous refresh calls) would otherwise drop one. The queue is small and naturally bounded by the number of in-flight backend requests.

- [ ] **Step 2: Syntax check**

```bash
node --check extension/modules/port.js
# Expected: exit 0
```

- [ ] **Step 3: Commit**

```bash
git add extension/modules/port.js
git commit -m "$(cat <<'EOF'
feat(ext): modules/port.js — single-active-Port registry + refresh helpers

First real use of chrome.runtime.Port in the extension.

registerPortHandler() is called once from service_worker.js top
level. It wires chrome.runtime.onConnectExternal, origin-allow-lists
connections against manifest.externally_connectable, and dispatches
incoming messages + lifecycle events to optional user handlers. The
one inbound type it handles DIRECTLY (not via the user handler) is
{type:"session"} — it writes the JWT to storage via auth.setJwt and
resolves any pending refresh promises.

getActivePort() returns the one slot or null. broadcastToPort(msg) is
a safe no-op when nothing is attached. waitForNextSessionMessage()
is used by refreshSessionViaPort() in auth.js — promise + 10s timeout
+ cleanup on port disconnect.

Circular-import note: auth.refreshSessionViaPort dynamically imports
port.js to avoid a static cycle (port.js imports setJwt from auth.js).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Service worker — register port handler + cookie watcher + debug check handler

Three top-level wirings added to `service_worker.js`. The existing `onMessageExternal` router is extended with one new `debug_check_envato_session` case.

**Files:**
- Modify: `extension/service_worker.js`

- [ ] **Step 1: Read current `service_worker.js`**

```bash
cat extension/service_worker.js
```

Ext.3's shape should include imports from `auth.js`, `envato.js`, `sources.js`, and the switch statement with cases for `ping`, `session`, `debug_envato_one_shot`, `debug_source_one_shot` (from Ext.3).

- [ ] **Step 2: Extend imports**

Use Edit on the import block. The OLD block (after Ext.3) likely reads:

```js
import { EXT_VERSION, MESSAGE_VERSION } from './config.js'
import { getJwt, setJwt, hasValidJwt } from './modules/auth.js'
import { downloadEnvato } from './modules/envato.js'
import { downloadFromSource } from './modules/sources.js'  // or whatever Ext.3 named it
```

Replace with:

```js
import { EXT_VERSION, MESSAGE_VERSION } from './config.js'
import {
  getJwt, setJwt, hasValidJwt,
  hasEnvatoSession, checkEnvatoSessionLive, onEnvatoSessionChange,
} from './modules/auth.js'
import { downloadEnvato } from './modules/envato.js'
import { downloadFromSource } from './modules/sources.js'
import { registerPortHandler, broadcastToPort } from './modules/port.js'
```

Inspect Ext.3's exact import line to get the right old_string. If Ext.3 imported `downloadPexels` and `downloadFreepik` separately instead of a unified `downloadFromSource`, keep those names — don't rename them as part of Ext.4.

- [ ] **Step 3: Add the cookie watcher + port handler wiring at the top of the file**

Locate the top-level code (between the imports and the `onMessageExternal.addListener`). Insert:

```js
// --- Ext.4: long-lived port registration ---
// Called once at SW boot. Future SW wake-ups re-run this file from
// scratch, which re-registers. onConnectExternal listeners are
// idempotent per registration call.
registerPortHandler({
  onConnect({ senderUrl }) { console.log('[port] connected from', senderUrl) },
  onDisconnect({ senderUrl }) { console.log('[port] disconnected from', senderUrl) },
  onMessage(msg, { senderUrl }) {
    // Ext.5 will route {type:"export"|"pause"|"resume"|"cancel"}
    // here. Ext.4 only knows {type:"session"} (handled inside
    // port.js). Anything else is logged and dropped.
    console.log('[port] inbound message', msg, 'from', senderUrl)
  },
})

// --- Ext.4: Envato cookie watcher ---
onEnvatoSessionChange(async ({ status }) => {
  await chrome.storage.local.set({ envato_session_status: status })
  broadcastToPort({ type: 'state', version: MESSAGE_VERSION, envato_session: status })
  if (status === 'missing') {
    try {
      chrome.action.setBadgeText({ text: '!' })
      chrome.action.setBadgeBackgroundColor({ color: '#dc2626' })
    } catch {}
  } else {
    try {
      chrome.action.setBadgeText({ text: '' })
    } catch {}
  }
  console.log('[envato-cookies] status ->', status)
})
```

Use Edit against a unique anchor near where you want to insert. Example:

- `old_string`:
  ```
  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  ```
- `new_string`:
  ```
  // --- Ext.4: long-lived port registration ---
  registerPortHandler({
    onConnect({ senderUrl }) { console.log('[port] connected from', senderUrl) },
    onDisconnect({ senderUrl }) { console.log('[port] disconnected from', senderUrl) },
    onMessage(msg, { senderUrl }) {
      console.log('[port] inbound message', msg, 'from', senderUrl)
    },
  })

  // --- Ext.4: Envato cookie watcher ---
  onEnvatoSessionChange(async ({ status }) => {
    await chrome.storage.local.set({ envato_session_status: status })
    broadcastToPort({ type: 'state', version: MESSAGE_VERSION, envato_session: status })
    if (status === 'missing') {
      try {
        chrome.action.setBadgeText({ text: '!' })
        chrome.action.setBadgeBackgroundColor({ color: '#dc2626' })
      } catch {}
    } else {
      try {
        chrome.action.setBadgeText({ text: '' })
      } catch {}
    }
    console.log('[envato-cookies] status ->', status)
  })

  chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  ```

- [ ] **Step 4: Update `handlePing` to return the real envato_session from storage**

Ext.1's `handlePing` returned a static `envato_session: 'missing'`. Replace with a read from storage:

Use Edit:
- `old_string`:
  ```
  async function handlePing() {
    const jwt = await getJwt()
    return {
      type: 'pong',
      version: MESSAGE_VERSION,
      ext_version: EXT_VERSION,
      envato_session: 'missing',   // Ext.1 has no cookie watcher yet — always "missing"
  ```
- `new_string`:
  ```
  async function handlePing() {
    const jwt = await getJwt()
    const { envato_session_status } = await chrome.storage.local.get('envato_session_status')
    // If the cookie watcher hasn't fired yet (fresh SW wake), fall
    // back to a best-effort read; still fast (no network).
    const envatoStatus = envato_session_status || (await hasEnvatoSession() ? 'ok' : 'missing')
    return {
      type: 'pong',
      version: MESSAGE_VERSION,
      ext_version: EXT_VERSION,
      envato_session: envatoStatus,
  ```

The trailing lines of the `return` object (has_jwt / jwt_expires_at) stay unchanged.

- [ ] **Step 5: Add the `debug_check_envato_session` handler**

Insert near the other `handle*` helpers (just before `isSupportedVersion`):

```js
// Ext.4 debug: fire an ad-hoc pre-flight check from the test page.
// Useful for "did my change to ENVATO_REFERENCE_UUID work?" loops.
async function handleDebugCheckEnvatoSession() {
  const cookiesOk = await hasEnvatoSession()
  const live = await checkEnvatoSessionLive()
  return {
    ok: true,
    cookies_ok: cookiesOk,
    live,
  }
}
```

And extend the switch:
- `old_string`:
  ```
        case 'debug_source_one_shot':
          sendResponse(await handleDebugSourceOneShot(msg))
          return
        default:
  ```
  (adjust to match the Ext.3 final shape — the immediate anchor before `default:` is what we want)
- `new_string`:
  ```
        case 'debug_source_one_shot':
          sendResponse(await handleDebugSourceOneShot(msg))
          return
        case 'debug_check_envato_session':
          sendResponse(await handleDebugCheckEnvatoSession())
          return
        default:
  ```

- [ ] **Step 6: Syntax check**

```bash
node --check extension/service_worker.js
# Expected: exit 0
```

- [ ] **Step 7: Commit**

```bash
git add extension/service_worker.js
git commit -m "$(cat <<'EOF'
feat(ext): service worker — port registration + cookie watcher + session debug

Three top-level additions:

1. registerPortHandler() — wires chrome.runtime.onConnectExternal via
   modules/port.js. Logs connect/disconnect; inbound {type:"session"}
   is handled inside port.js, others are logged for now (Ext.5 will
   route queue commands here).

2. onEnvatoSessionChange() — subscribes to chrome.cookies.onChanged
   via modules/auth.js. On transitions: writes
   envato_session_status to chrome.storage.local, broadcasts a
   {type:"state", envato_session:...} message to the active Port (if
   any), and updates the toolbar badge (red "!" when missing, clear
   otherwise).

3. handleDebugCheckEnvatoSession — new switch case
   {type:"debug_check_envato_session", version:1}. Returns
   {cookies_ok, live:{status, httpStatus?, detail?}}. Used by the
   test page to exercise pre-flight without running a full Envato
   one-shot.

handlePing now returns the real envato_session status from storage
(falling back to a live cookie read if the watcher hasn't primed
storage yet).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Envato module hook — Phase 0 preflight + handle401Envato

Two hooks in `modules/envato.js`: pre-flight as a new Phase 0 in `downloadEnvato()`, and a private `handle401Envato()` called from the 401 branch in `getSignedDownloadUrl()`.

**Files:**
- Modify: `extension/modules/envato.js`

- [ ] **Step 1: Extend imports**

Current from Ext.2:
```js
import { RESOLVER_TIMEOUT_MS } from '../config.js'
```

Replace:

- `old_string`: `import { RESOLVER_TIMEOUT_MS } from '../config.js'`
- `new_string`:
  ```
  import { RESOLVER_TIMEOUT_MS, MESSAGE_VERSION } from '../config.js'
  import { checkEnvatoSessionLive } from './auth.js'
  import { broadcastToPort } from './port.js'
  ```

- [ ] **Step 2: Add private `handle401Envato()` helper**

Insert ABOVE `resolveOldIdToNewUuid` (or wherever fits — private helpers can live near the top):

```js
// Called when Phase 2 returns 401. Updates the shared session flag,
// broadcasts to the Port so the web app can react, and raises the
// badge. Does NOT throw — the caller still throws envato_session_missing
// so the single-download handler hard-stops. Ext.5 will add the
// queue-pause here.
async function handle401Envato() {
  try {
    await chrome.storage.local.set({ envato_session_status: 'missing' })
  } catch {}
  try {
    broadcastToPort({ type: 'state', version: MESSAGE_VERSION, envato_session: 'missing' })
  } catch {}
  try {
    chrome.action.setBadgeText({ text: '!' })
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' })
  } catch {}
}
```

- [ ] **Step 3: Call `handle401Envato()` from the 401 branch**

In `getSignedDownloadUrl`, replace:

```js
if (resp.status === 401) throw new Error('envato_session_missing')
```

with:

```js
if (resp.status === 401) {
  await handle401Envato()
  throw new Error('envato_session_missing')
}
```

Use Edit with a precise old_string to guarantee uniqueness:
- `old_string`: `  if (resp.status === 401) throw new Error('envato_session_missing')`
- `new_string`:
  ```
    if (resp.status === 401) {
      await handle401Envato()
      throw new Error('envato_session_missing')
    }
  ```

- [ ] **Step 4: Add Phase 0 preflight in `downloadEnvato`**

The public `downloadEnvato` currently starts with input validation then Phase 1. Insert a Phase 0 block between input validation and Phase 1.

Use Edit on the existing early-return block. Approximate current shape:

```js
export async function downloadEnvato({ envatoItemUrl, itemId, runId, sanitizedFilename }) {
  if (!envatoItemUrl || typeof envatoItemUrl !== 'string') {
    return { ok: false, errorCode: 'bad_input', detail: 'envatoItemUrl missing or non-string' }
  }
  if (!itemId || typeof itemId !== 'string') {
    return { ok: false, errorCode: 'bad_input', detail: 'itemId missing or non-string' }
  }

  const t0 = Date.now()
  let newUuid
  try {
    newUuid = await resolveOldIdToNewUuid(envatoItemUrl)
  ...
```

Insert between the input-validation close and the `const t0 = Date.now()` line:

- `old_string`:
  ```
    if (!itemId || typeof itemId !== 'string') {
      return { ok: false, errorCode: 'bad_input', detail: 'itemId missing or non-string' }
    }

    const t0 = Date.now()
  ```
- `new_string`:
  ```
    if (!itemId || typeof itemId !== 'string') {
      return { ok: false, errorCode: 'bad_input', detail: 'itemId missing or non-string' }
    }

    // Phase 0 — preflight session check. One GET against the reference
    // UUID. 200 = proceed. 401 = session gone; surface immediately
    // without spending a license or opening a tab. Non-401 errors are
    // treated as pre-flight error (may be a transient network issue OR
    // the reference UUID has been delisted — both require user /
    // developer attention).
    const preflight = await checkEnvatoSessionLive()
    if (preflight.status === 'missing') {
      await handle401Envato()
      return { ok: false, errorCode: 'envato_session_missing_preflight', detail: preflight.detail || 'download.data returned 401 on reference item' }
    }
    if (preflight.status === 'error') {
      return { ok: false, errorCode: 'envato_preflight_error', detail: preflight.detail || `http ${preflight.httpStatus}` }
    }
    console.log('[envato] phase 0 preflight OK')

    const t0 = Date.now()
  ```

- [ ] **Step 5: Syntax check**

```bash
node --check extension/modules/envato.js
# Expected: exit 0
```

- [ ] **Step 6: Commit**

```bash
git add extension/modules/envato.js
git commit -m "$(cat <<'EOF'
feat(ext): envato — Phase 0 preflight + handle401Envato hook

downloadEnvato() now starts with a Phase 0 preflight that calls
checkEnvatoSessionLive() against ENVATO_REFERENCE_UUID. On 401 we
return errorCode 'envato_session_missing_preflight' WITHOUT opening
the resolver tab or hitting Phase 2 (no license spent). On other
non-200 we return 'envato_preflight_error' so ops can distinguish
transient network issues from a delisted reference UUID.

getSignedDownloadUrl()'s existing 401 branch now also calls the new
private handle401Envato() before throwing envato_session_missing —
that helper sets envato_session_status='missing' in storage,
broadcasts {type:"state", envato_session:"missing"} to the Port (if
connected), and turns the toolbar badge red. The throw still hits
the caller so the single-download debug handler hard-stops.

Ext.5 will add queue-pause to handle401Envato; Ext.4 has no queue.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Sources module hook — 401 retry-once via Port refresh

Wraps the backend URL fetcher(s) in `modules/sources.js` with a single retry that's gated on a successful `refreshSessionViaPort()`. If the Port isn't there, or refresh times out, the 401 surfaces up unchanged.

**Files:**
- Modify: `extension/modules/sources.js`

- [ ] **Step 1: Read current `sources.js`**

```bash
cat extension/modules/sources.js
```

Ext.3's exact shape matters here — it may export `downloadPexels` / `downloadFreepik` individually, or a unified `downloadFromSource` that dispatches internally, or helpers like `fetchPexelsUrl`. The 401 branch is the target. Find the line(s) that look like:

```js
if (resp.status === 401) throw new Error('api_auth_failed')
```

or similar. There may be two (Pexels + Freepik). We wrap both.

- [ ] **Step 2: Extract the 401 path into a retry-wrapper helper**

Add at the top of the file (after imports), a wrapper that encapsulates "fetch with one retry on 401":

```js
import { getJwt, refreshSessionViaPort } from './auth.js'

// Backend fetch with one retry on 401. Called by the Pexels + Freepik
// URL fetchers so we avoid copy-pasting the refresh dance.
//
// On first 401, try a refreshSessionViaPort() round-trip. If it
// succeeds, retry the original fetch ONCE with the (newly persisted)
// JWT. If the refresh fails (no port / 10s timeout / disconnect),
// re-throw the original 401. NO further retries — Ext.4 is
// retry-once-then-surface per spec.
export async function backendFetchWithRefresh(url, init = {}) {
  const jwt = await getJwt()
  const authedInit = {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(jwt?.token ? { 'Authorization': `Bearer ${jwt.token}` } : {}),
    },
  }
  const resp = await fetch(url, authedInit)
  if (resp.status !== 401) return resp

  // 401 path — try one refresh + retry.
  try {
    await refreshSessionViaPort()
  } catch (err) {
    // Can't recover; let the original 401 bubble up.
    return resp
  }
  const freshJwt = await getJwt()
  const retryInit = {
    ...init,
    headers: {
      ...(init.headers || {}),
      ...(freshJwt?.token ? { 'Authorization': `Bearer ${freshJwt.token}` } : {}),
    },
  }
  return fetch(url, retryInit)
}
```

If Ext.3's `sources.js` already imports `getJwt`, don't double-import — rewrite the import line to cover both.

- [ ] **Step 3: Wire the helper into the backend URL fetchers**

Find each place that currently calls `fetch(BACKEND_URL + '/api/pexels-url', {...})` (and the Freepik equivalent) and replace with `backendFetchWithRefresh(...)`.

Example (adapt to real shape):

- `old_string`:
  ```
  const resp = await fetch(`${BACKEND_URL}/api/pexels-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt.token}`,
    },
    body: JSON.stringify({ item_id: itemId, preferred_resolution: '1080p' }),
  })
  ```
- `new_string`:
  ```
  const resp = await backendFetchWithRefresh(`${BACKEND_URL}/api/pexels-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ item_id: itemId, preferred_resolution: '1080p' }),
  })
  ```

Note: `backendFetchWithRefresh` attaches Authorization itself, so remove the explicit header. Apply the same pattern to the Freepik fetch.

If Ext.3 already has a centralized `backendFetch` helper, the clean move is to rename it to `backendFetchWithRefresh` and enhance it in place rather than adding a second helper.

- [ ] **Step 4: Syntax check**

```bash
node --check extension/modules/sources.js
# Expected: exit 0
```

- [ ] **Step 5: Commit**

```bash
git add extension/modules/sources.js
git commit -m "$(cat <<'EOF'
feat(ext): sources — 401 retry-once via refreshSessionViaPort

Adds backendFetchWithRefresh wrapper that attaches the stored JWT as
Authorization header, fetches, and on 401:

1. Calls auth.refreshSessionViaPort() — posts {type:"refresh_session"}
   on the active Port and awaits a fresh {type:"session", ...} inbound.
2. If refresh succeeds, reads the new JWT from storage and retries the
   original fetch ONCE with the fresh token.
3. If refresh fails (no port / 10s timeout / port disconnect), returns
   the original 401 response — caller decides how to surface.

No backoff, no second retry. Ext.7 will extend this with the full
retry matrix.

The Pexels + Freepik URL fetch paths now go through
backendFetchWithRefresh instead of raw fetch(...).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Popup — dynamic Envato row + live storage updates + sign-in click handlers

Popup becomes genuinely useful: Envato row shows green/amber with click-to-sign-in; transcript-eval row live-updates when a session message arrives while the popup is open.

**Files:**
- Modify: `extension/popup.js`
- Modify: `extension/popup.html` (small — button affordance ID)
- Modify: `extension/popup.css` (minor — button style)

- [ ] **Step 1: Read current popup files**

```bash
cat extension/popup.html
cat extension/popup.js
cat extension/popup.css
```

Ext.1's popup.js renders once and doesn't listen for storage changes.

- [ ] **Step 2: Update `popup.html`**

Re-check — Ext.1's HTML already has `row-envato`, `status-envato`, `detail-envato` IDs. Those are enough; no structural change needed. Don't over-edit.

- [ ] **Step 3: Update `popup.js`**

Replace the existing file with a version that (a) renders the Envato row dynamically, (b) subscribes to `chrome.storage.onChanged` for live updates, (c) handles click on both rows when they're in "not connected / sign in required" state.

Keep the Ext.1 `setRow` helper; extend `render()`.

- `old_string` (the entire `render()` function from Ext.1, ending with `render()` at the bottom):
  ```
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
- `new_string`:
  ```
  import { hasEnvatoSession } from './modules/auth.js'

  async function renderEnvatoRow(statusFromStorage) {
    const rowEn = document.getElementById('row-envato')
    const statusEn = document.getElementById('status-envato')
    const detailEn = document.getElementById('detail-envato')

    // Trust storage when it has a value; fall back to a live cookie
    // read for the first-run case (watcher hasn't primed storage).
    let status = statusFromStorage
    if (status !== 'ok' && status !== 'missing') {
      status = (await hasEnvatoSession()) ? 'ok' : 'missing'
    }

    if (status === 'ok') {
      setRow(rowEn, statusEn, detailEn, {
        text: 'connected',
        className: 'ok',
        detail: 'session cookies present',
      })
    } else {
      setRow(rowEn, statusEn, detailEn, {
        text: 'sign in required',
        className: 'warn',
        detail: 'Click to open Envato sign-in',
        onClick: () => chrome.tabs.create({ url: 'https://app.envato.com/sign-in' }),
      })
    }
    return status
  }

  async function renderTeRow() {
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
    return connected
  }

  async function renderBanner() {
    const { envato_session_status } = await chrome.storage.local.get('envato_session_status')
    const jwt = await getJwt()
    const teOk = !!jwt && jwt.expires_at > Date.now()
    const envOk = envato_session_status === 'ok' || (envato_session_status == null && await hasEnvatoSession())
    const banner = document.getElementById('banner')
    if (teOk && envOk) banner.textContent = 'Ready. Start an export from transcript-eval.'
    else if (!teOk) banner.textContent = 'Sign in at transcript-eval to continue.'
    else banner.textContent = 'Sign in to Envato to continue.'
  }

  async function render() {
    document.getElementById('version').textContent = `v${EXT_VERSION}`
    const { envato_session_status } = await chrome.storage.local.get('envato_session_status')
    await renderTeRow()
    await renderEnvatoRow(envato_session_status)
    await renderBanner()
  }

  // Live updates: if a new JWT arrives OR the cookie watcher updates
  // envato_session_status while the popup is open, re-render rather
  // than showing stale state.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    if ('jwt' in changes || 'envato_session_status' in changes) {
      render()
    }
  })

  render()
  ```

- [ ] **Step 4: Update `popup.css` — add a `.row.clickable-action` affordance**

Check the existing CSS; Ext.1 already has `.row.clickable:hover`. That's enough — the Envato "sign in" hover state reuses the same class. Skip if no changes feel needed.

If you want a small visual touch, append:

```css
.row.clickable::after {
  content: ' ›';
  color: var(--muted);
  font-size: 14px;
}
```

Keep subtle; popup already does the job.

- [ ] **Step 5: Syntax check**

```bash
node --check extension/popup.js
# Expected: exit 0
```

- [ ] **Step 6: Commit**

```bash
git add extension/popup.js extension/popup.html extension/popup.css
git commit -m "$(cat <<'EOF'
feat(ext): popup — dynamic Envato row + live storage updates + sign-in

Envato row is no longer a static placeholder. Reads
envato_session_status from chrome.storage.local (primed by the cookie
watcher in service_worker.js), falls back to a live hasEnvatoSession()
read on first run. Renders:

- 'connected' (green) when cookies present
- 'sign in required' (amber, clickable) when missing; click opens
  https://app.envato.com/sign-in in a new tab

Adds a chrome.storage.onChanged listener so the popup re-renders in
place when:
- a fresh JWT lands (e.g. user signed in on the web app while popup
  was open) — jwt key changes
- the cookie watcher flips envato_session_status — envato_session_status
  key changes

Banner text adapts to cover three states: fully ready, need
transcript-eval sign-in, need Envato sign-in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Test harness — three new fieldsets (Port + Auth, Session status, 401 refresh simulation)

Adds dev-tool affordances to exercise Port lifecycle, session status, and refresh flow without running a full Envato or Pexels one-shot.

**Files:**
- Modify: `extension-test.html` (at repo root)

- [ ] **Step 1: Read current test harness**

The last fieldset from Ext.3 is "Source one-shot (Ext.3)" — the Ext.4 fieldsets go after it and before the inline `<script type="module">`.

- [ ] **Step 2: Insert fieldset 6 — Port + Auth**

Add immediately after the Ext.3 "5. Envato one-shot" OR "6. Source one-shot" fieldset (whichever is last). Use Edit.

- `old_string`: (the closing `</fieldset>` of the last Ext.3 fieldset + the `<script type="module">` tag)
  ```
      <pre id="out-source">(no response yet)</pre>
    </fieldset>

    <script type="module">
  ```
  (adapt to Ext.3's real final fieldset ID)
- `new_string`:
  ```
      <pre id="out-source">(no response yet)</pre>
    </fieldset>

    <fieldset>
      <legend>7. Port + Auth (Ext.4)</legend>
      <p class="muted" style="margin-top: 0;">
        Exercises chrome.runtime.connect(EXT_ID). Keeps the port open so
        the extension can push messages to this page. Disconnect via button
        or by reloading the page.
      </p>
      <div class="row">
        <button id="btn-port-connect">Connect Port</button>
        <button id="btn-port-disconnect" disabled>Disconnect</button>
        <span id="port-status" class="muted">idle</span>
      </div>
      <pre id="out-port">(no messages yet)</pre>
    </fieldset>

    <fieldset>
      <legend>8. Session status (Ext.4)</legend>
      <p class="muted" style="margin-top: 0;">
        Live view of envato_session_status (poll every 2s). Button runs the
        network pre-flight via debug_check_envato_session.
      </p>
      <div class="row">
        <span><strong>storage.envato_session_status:</strong></span>
        <span id="storage-envato-status">—</span>
      </div>
      <div class="row">
        <button id="btn-check-envato">Run debug_check_envato_session</button>
      </div>
      <pre id="out-check-envato">(no response yet)</pre>
    </fieldset>

    <fieldset>
      <legend>9. 401 refresh simulation (Ext.4)</legend>
      <p class="muted" style="margin-top: 0;">
        Sends {type:"refresh_session"} over the connected Port. Connect the
        port first (fieldset 7), then click below. The extension normally
        posts this itself after a 401; here you fire it manually.
        To complete the round-trip, reply with a {type:"session"} message
        via the existing sendMessage path (fieldset 2) or from your own code
        — the extension will write the JWT and resolve any pending refresh
        promise internally.
      </p>
      <div class="row">
        <button id="btn-post-refresh" disabled>Post {type:"refresh_session"} via Port</button>
      </div>
      <pre id="out-refresh">(not sent)</pre>
    </fieldset>

    <script type="module">
  ```

- [ ] **Step 3: Append handlers to the inline `<script type="module">` block**

Insert just before `</script>`:

```js
      // ---- Ext.4 Port + Auth ----
      let activeTestPort = null
      const portStatusEl = document.getElementById('port-status')
      const portOutEl = document.getElementById('out-port')
      const btnConnect = document.getElementById('btn-port-connect')
      const btnDisconnect = document.getElementById('btn-port-disconnect')
      const btnPostRefresh = document.getElementById('btn-post-refresh')

      function logPort(line) {
        const ts = new Date().toISOString().slice(11, 23)
        portOutEl.textContent = `[${ts}] ${line}\n` + portOutEl.textContent
      }

      btnConnect.onclick = () => {
        try {
          const id = getExtId()
          activeTestPort = chrome.runtime.connect(id, { name: 'test-harness' })
          portStatusEl.textContent = 'connected'
          portStatusEl.className = 'status-ok'
          btnConnect.disabled = true
          btnDisconnect.disabled = false
          btnPostRefresh.disabled = false
          logPort('connected')
          activeTestPort.onMessage.addListener(msg => logPort('IN  ' + pretty(msg)))
          activeTestPort.onDisconnect.addListener(() => {
            portStatusEl.textContent = 'disconnected'
            portStatusEl.className = 'status-err'
            btnConnect.disabled = false
            btnDisconnect.disabled = true
            btnPostRefresh.disabled = true
            const err = chrome.runtime.lastError
            logPort('disconnected' + (err ? ' (' + err.message + ')' : ''))
            activeTestPort = null
          })
        } catch (e) {
          logPort('EXCEPTION: ' + (e.message || e))
        }
      }

      btnDisconnect.onclick = () => {
        try { activeTestPort?.disconnect() } catch {}
      }

      btnPostRefresh.onclick = () => {
        const out = document.getElementById('out-refresh')
        if (!activeTestPort) {
          out.textContent = 'no port — connect first'
          return
        }
        try {
          activeTestPort.postMessage({ type: 'refresh_session', version: 1 })
          out.textContent = 'posted {type:"refresh_session", version:1}. Reply via fieldset 2 (sendMessage {type:"session",...}) to complete.'
        } catch (e) {
          out.textContent = 'ERROR: ' + (e.message || e)
        }
      }

      // ---- Ext.4 Session status ----
      const storageStatusEl = document.getElementById('storage-envato-status')
      async function refreshStorageStatus() {
        try {
          const id = getExtId()
          // Use sendMessage to avoid depending on port state.
          const r = await send({ type: 'ping', version: 1 })
          storageStatusEl.textContent = r?.envato_session ?? '—'
          storageStatusEl.className = r?.envato_session === 'ok' ? 'status-ok'
            : r?.envato_session === 'missing' ? 'status-err' : ''
        } catch {
          storageStatusEl.textContent = '—'
          storageStatusEl.className = ''
        }
      }
      setInterval(refreshStorageStatus, 2000)
      refreshStorageStatus()

      document.getElementById('btn-check-envato').onclick = () => showResult('out-check-envato',
        send({ type: 'debug_check_envato_session', version: 1 })
      )
```

- [ ] **Step 4: Sanity check**

```bash
grep -c 'debug_check_envato_session' extension-test.html
# Expected: >= 2 (legend + send() call)
grep -c 'chrome.runtime.connect' extension-test.html
# Expected: 1
```

- [ ] **Step 5: Commit**

```bash
git add extension-test.html
git commit -m "$(cat <<'EOF'
feat(ext): test harness — Port, session status, 401 refresh fieldsets

Three new dev-tool fieldsets on extension-test.html:

7. Port + Auth — Connect / Disconnect buttons around
   chrome.runtime.connect(EXT_ID). Inbound messages are timestamped
   and prepended to a log pane so state/refresh_session/etc pushes
   are visible without rereading code.

8. Session status — polls chrome.runtime.sendMessage({type:"ping"})
   every 2s to show the live envato_session value from the extension's
   handlePing. Button manually fires debug_check_envato_session for
   the two-part result (cookies_ok + live pre-flight).

9. 401 refresh simulation — posts {type:"refresh_session", version:1}
   over the connected test-harness Port. To complete the round-trip,
   use fieldset 2's {type:"session", ...} sendMessage (the extension's
   port.js handles inbound {type:"session"} on ANY connected port;
   the test-page doesn't need to round-trip through the real web
   app).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Manual load-unpacked smoke test (no commit)

End-to-end verification. Human-driven. This is the Ext.4 acceptance gate.

**Prereq:** Dev server running on port 5173 in a separate terminal. Envato subscription account signed in to the same Chrome profile. `ENVATO_REFERENCE_UUID` in `auth.js` SET TO A REAL VALUE (see Open question below — the placeholder `'00000000-...'` will cause pre-flight to return `error` with HTTP 404/500, not `ok`). Fix this before Step 5.

- [ ] **Step 1: Start vite dev**

```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-ext4"
npm install
npm run dev:client
```

Expected `Local: http://localhost:5173/` line. Do NOT touch 3001.

- [ ] **Step 2: Reload the extension**

1. `chrome://extensions` → **transcript-eval Export Helper**.
2. If Chrome complains "Manifest change requires permission re-approval" (cookies is a new permission), click the permissions prompt and accept.
3. Click **reload**.
4. Card version should read **0.4.0**.
5. Click **service worker** to open SW DevTools. Leave open.

- [ ] **Step 3: Regression — ping and existing one-shots work**

1. Open `http://localhost:5173/extension-test.html`.
2. Fieldset 1: click **Send {type:"ping"}**. Expect `ext_version: "0.4.0"` and `envato_session` is `"ok"` or `"missing"` (real, not static).
3. Fieldset 5 (Envato one-shot): only run if a real Envato URL is at hand AND you want to spend a license. If so, pick a valid item and click — Phase 0 preflight must log in SW console, then Phase 1/2/3 as in Ext.2.

- [ ] **Step 4: Port connect / disconnect**

1. Fieldset 7: paste ext ID if needed (localStorage persists). Click **Connect Port**.
2. SW DevTools shows `[port] connected from http://localhost:5173`.
3. Test-page log shows `connected`.
4. Click **Disconnect**. SW DevTools shows `[port] disconnected from ...`.

- [ ] **Step 5: Cookie watcher**

Need two Chrome tabs: one for the test page, one for `chrome://settings/cookies/detail?site=envato.com`.

1. While signed in to Envato, open the test page (fieldset 8 shows `ok`).
2. In `chrome://settings/cookies/detail?site=envato.com` remove `elements.session.5`. (Or use DevTools on app.envato.com → Application → Cookies → delete.)
3. Expect within a second:
   - SW DevTools: `[envato-cookies] status -> missing`.
   - Toolbar badge on the extension icon turns red `!`.
   - Test page fieldset 8 shows `missing` within 2s.
   - Popup (click icon): Envato row shows `sign in required` with click-affordance.
4. Click the Envato row in the popup. Chrome opens `https://app.envato.com/sign-in`.
5. Sign back in. Once cookies are set:
   - SW DevTools: `[envato-cookies] status -> ok`.
   - Badge clears.
   - Popup row returns to `connected` (reopen popup; `chrome.storage.onChanged` re-renders live if still open).

- [ ] **Step 6: Pre-flight before Envato one-shot**

This step COMMITS an Envato license if REFERENCE_UUID points at a stock-video item.

1. Ensure `ENVATO_REFERENCE_UUID` is a real valid UUID. If it's still `00000000-...`, stop and fix before continuing — Step 6 will fail with `envato_preflight_error`.
2. Fieldset 5 (Envato one-shot) with a real item URL. Click.
3. SW DevTools logs:
   ```
   [envato] phase 0 preflight OK
   [envato] phase 1 resolve OK ...
   [envato] phase 2 license OK ...
   [envato] phase 3 download started ...
   ```
4. Reply in test page: `{ok:true, filename, downloadId}`.

- [ ] **Step 7: Pre-flight with session gone**

1. Sign OUT of Envato (remove both cookies).
2. Fieldset 8 (session status): should read `missing`.
3. Fieldset 5 (Envato one-shot) with a real URL: click.
4. Expect REPLY within <1s (before the resolver tab would have opened):
   ```json
   {"ok":false,"errorCode":"envato_session_missing_preflight","detail":"..."}
   ```
5. No tab opened, no license consumed. SW DevTools: NO Phase 1/2/3 lines — only Phase 0 exiting via the `missing` branch.

- [ ] **Step 8: Transcript-eval 401 refresh simulation**

1. Connect Port (fieldset 7).
2. Artificially expire the JWT: fieldset 2, click **Send expired session**. Run a ping — `has_jwt: false`.
3. Fieldset 9: click **Post {type:"refresh_session"} via Port**. The port-log (fieldset 7) should NOT yet show anything inbound — the extension received the refresh but has nothing pending on its end (no in-flight 401). This is expected; the purpose of Task 10 Step 8 is to verify the Port delivery works.
4. To round-trip: back to fieldset 2, click **Send {type:"session"}** (the fresh version — `expires_at: now + 1h`). The inbound session is processed by `port.js` on any connected port; storage updates. Ping again — `has_jwt: true`.

(A fuller test of the auto-refresh path requires running a source one-shot with an expired JWT and observing the retry — that's outside this manual smoke and can be skipped unless debugging a specific regression.)

- [ ] **Step 9: Do NOT commit anything from this task**

```bash
git status
# Expected: "nothing to commit, working tree clean" — unless you changed ENVATO_REFERENCE_UUID, in which case that change IS a real edit and should be committed separately with a "chore(ext): set real ENVATO_REFERENCE_UUID" message.
```

If Steps 5–8 fail:
- **Badge doesn't update on cookie change** → `chrome.cookies.onChanged` is not firing. Check manifest has `"cookies"` permission. Re-check the domain filter in `onEnvatoSessionChange` (may need `c.domain.endsWith('.envato.com')` depending on how Chrome normalizes).
- **Pre-flight returns `error` instead of `ok`/`missing`** → REFERENCE_UUID is wrong or the item was delisted. Rotate it to a new stable item per the comment in `auth.js`.
- **Port connect shows no log in SW** → check ext ID matches; check origin allow-list in `port.js` covers `http://localhost:5173`.
- **Popup Envato row stays `unknown`** → `chrome.storage.onChanged` listener not firing. Check areaName filter, check the key names in the if-check.

---

## Task 11: Extend README + final polish

**Files:**
- Modify: `extension/README.md`

- [ ] **Step 1: Append the Ext.4 section**

At the bottom of README.md, append a new section after the Ext.2/Ext.3 sections:

```markdown
## Ext.4 — Auth polish (Port + Cookie Watcher + Session Recovery)

Ext.4 adds the glue that keeps the extension reliable across
session-boundary events (user signs out, JWT expires, web app
reloads, etc.).

### New permissions

Ext.4 adds one permission to `manifest.json`:

- `cookies` — required for `chrome.cookies.get` (pre-flight
  convenience) and `chrome.cookies.onChanged` (reactive cookie
  watcher).

### Privacy posture for `cookies`

The extension ONLY reads cookies on `.envato.com`, and only two
of them: `envato_client_id` and `elements.session.5`. It NEVER:

- writes any cookie
- reads cookies on any other domain
- sends cookie values to our backend or to the Port-connected web
  app

Surface the user sees: a red badge `!` on the extension icon when
the Envato session is missing; a "sign in required" row in the
popup that opens `https://app.envato.com/sign-in` on click.

### Port (long-lived connection)

The web app's export page opens a `chrome.runtime.Port` when it
loads; it auto-disconnects when the tab closes. Only one active
Port is tracked; a new connection replaces the previous.

The extension uses the Port for:

- **Outbound**: `{type:"state", envato_session:"ok"|"missing"}`
  on cookie change; `{type:"refresh_session", version:1}` when a
  401 needs a fresh JWT.
- **Inbound**: `{type:"session", token, kid, user_id, expires_at}`
  to update the stored JWT (written via `modules/auth.setJwt`).

Ext.5 will extend the inbound path with `{type:"export"|"pause"|
"resume"|"cancel"}` queue commands.

### Pre-flight session check

`downloadEnvato()` (Ext.2) now starts with a Phase 0 pre-flight:
one GET to `app.envato.com/download.data?itemUuid=<REFERENCE>` with
the user's session cookies. On 401, the run returns
`envato_session_missing_preflight` before opening any resolver tab
— no license, no CPU wasted.

`ENVATO_REFERENCE_UUID` in `modules/auth.js` points at a stable
Envato stock-video item. If Envato delists it, pre-flight will
start returning `envato_preflight_error`; rotate the constant per
the docstring in that file.

### 401 recovery

Two paths:

- **Envato 401** (on `download.data`) → set
  `envato_session_status = 'missing'` in storage, broadcast on
  Port, red badge, surface `envato_session_missing` error. Queue
  pause is Ext.5.
- **transcript-eval 401** (on `/api/pexels-url` / `/api/freepik-url`)
  → `refreshSessionViaPort()` posts `{type:"refresh_session"}` on
  the Port, awaits a fresh `{type:"session", ...}` inbound within
  10s, retries the original fetch ONCE. No port / timeout →
  surface the 401 unchanged.

### Test harness additions

Fieldsets 7–9 on `extension-test.html`:

- 7. Port + Auth — connect / disconnect buttons; live inbound log.
- 8. Session status — live storage poll + manual
  `debug_check_envato_session`.
- 9. 401 refresh simulation — manual
  `{type:"refresh_session"}` post over the connected Port.
```

- [ ] **Step 2: Commit**

```bash
git add extension/README.md
git commit -m "$(cat <<'EOF'
docs(ext): README — Ext.4 auth polish section

Documents the cookies permission + privacy posture, the Port
lifecycle and in/out message types, pre-flight rationale, the
ENVATO_REFERENCE_UUID rotation story, 401 recovery split (Envato vs
transcript-eval), and the three new test-harness fieldsets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Full branch review**

```bash
git log --oneline feature/extension-ext3-sources..HEAD  # or main..HEAD if ext3 merged
# Expected: 10 commits — Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 11 each produce one commit. Tasks 0 and 10 are setup + verification, no commit.

git diff feature/extension-ext3-sources --stat  # or main
# Expected additions (approximate):
#   extension-test.html                              | 120+
#   extension/README.md                              |  70+
#   extension/config.js                              |   1+
#   extension/manifest.json                          |   2+
#   extension/modules/auth.js                        | 120+
#   extension/modules/envato.js                      |  30+
#   extension/modules/port.js                        | 120+
#   extension/modules/sources.js                     |  30+
#   extension/popup.js                               |  80+
#   extension/service_worker.js                      |  50+
```

If `git diff` surfaces anything outside `extension/` or `extension-test.html`, investigate. Revert unrelated changes before finalizing.

- [ ] **Step 4: DO NOT push**

Per user convention: `git push` requires explicit consent. This task's acceptance is "all 10 commits on the local branch, branch ready for review." Surface the branch name + last commit sha to the user; ask before pushing.

---

## Self-review against the spec

After completing Tasks 0–11, re-read the following sources:

**Roadmap (`docs/specs/2026-04-24-export-remaining-roadmap.md`) § "Ext.4 — Auth polish"** coverage check:

- 401 recovery — ✓ (sources.js retry-once via Port; envato.js flag + surface)
- Envato cookie watcher — ✓ (auth.onEnvatoSessionChange + SW subscription + storage flag)
- Popup sign-in flows — ✓ (both rows clickable when not-connected; correct URLs)
- Files listed: `modules/auth.js` expansion, `popup.js` click handlers, `service_worker.js` Port registration — all present.
- Envato cookie names `envato_client_id` + `elements.session.5` on `.envato.com` — ✓
- Pre-flight GET `download.data` with reference itemUuid — ✓
- 401 handling: Port `{type:"refresh_session"}`, wait 10s, resume on new token OR popup banner on failure — ✓ (sources.js retry-once; Envato's queue-pause deferred to Ext.5 per "hold the line")
- Verification: expire session by clearing Envato cookies, observe popup prompt + badge — ✓ (Task 10 Step 5)

**Extension spec (`/tmp/ext-spec.md`) § "Authentication flows" / "Web app ↔ extension messaging"** coverage:

- Extension uses browser cookies for Envato — ✓
- `chrome.cookies.onChanged` watching `envato_client_id` + `elements.session.5` — ✓
- JWT stored in `chrome.storage.local`, received via `{type:"session"}` — ✓ (port.js handles the inbound session write)
- On 401 from backend: push `{type:"refresh_session"}`, wait 10s — ✓ (refreshSessionViaPort with 10s timeout)
- If web app not connected, popup shows "Open transcript-eval to continue" — partial: popup shows "Sign in at transcript-eval to continue." in banner; explicit "Open transcript-eval" framing is in the row detail. Close enough for Ext.4; cleaner wording can land in Ext.5 popup polish.
- `chrome.runtime.onConnectExternal` → register new Port → port.js — ✓
- Pre-flight before every run — ✓ in Phase 0 of downloadEnvato; Ext.5 will add the same for the queue orchestrator
- `envato_session` field in `pong` reply populated from the real state — ✓

**Spec § "Popup status surface"**:

- Rows clickable when red → launch sign-in flow — ✓
- Envato row, transcript-eval row — ✓

**Ext.4 scope hold-the-line check:**

- No queue → correct; `modules/queue.js` does NOT exist (Ext.5)
- No full retry matrix → correct; only retry-once in sources.js
- No periodic re-check during long runs → correct; pre-flight only per run
- No telemetry to /api/export-events → correct; Ext.6
- No icons/polish — correct

**Open questions not resolved (expected — not in scope):**

- OQ2 (`/api/ext-config`) → Ext.9.
- OQ3 (Freepik URL TTL parsing) → Ext.7.

---

## Inputs parked for Ext.5+

These are NOT used in Ext.4 — capturing so they aren't lost when the relevant downstream phase picks up:

**For Ext.5 (queue + concurrency + persistence):**

- `handle401Envato()` currently sets the flag + broadcasts + surfaces error. Ext.5 adds `queue.pause()` here, plus a `queue.onEnvatoSessionRestored()` hook that auto-resumes when `envato_session_status` flips back to `'ok'` via the cookie watcher.
- `port.js` registerPortHandler routes inbound `{type:"session"}` itself; Ext.5 will route `{type:"export"|"pause"|"resume"|"cancel"}` through the `onMessage` user handler passed to `registerPortHandler({...})`.
- Pre-flight is currently in `downloadEnvato()` Phase 0. When the queue orchestrator lands, move it to `queue.start()` so the single pre-flight serves N items instead of firing once per item.
- `MESSAGE_VERSION` is imported into envato.js now; Ext.5's state broadcasts should use the same constant so schema bumps propagate.

**For Ext.6 (telemetry):**

- `handle401Envato()` is the exact hook point for the `session_expired` telemetry event (fire once per run max). Today it only updates storage + badge + broadcast; Ext.6 adds `telemetry.emit('session_expired', {...})`.
- Similar hook in `sources.js` for `item_failed` after a failed refresh round-trip.

**For Ext.7 (failure matrix):**

- The retry-once-on-401 in `backendFetchWithRefresh` is the correct MVP for Ext.4; Ext.7 replaces it with the full backoff + Retry-After + jitter flow documented in `/tmp/ext-spec.md` § "Failure handling (full matrix)". The single-retry behavior is the floor; backoff is layered on top.
- Similarly, `envato_preflight_error` today is a dead-end; Ext.7 can classify it by HTTP status (5xx → backoff + retry; 404 → likely delisted UUID → escalate to developer).

**For Ext.11 (Chrome Web Store submission):**

- The `cookies` permission needs a clear one-line justification in the Web Store listing: "Reads Envato session cookies to detect when you need to sign in." Draft in README is already this exact wording; just copy to the listing field at submission time.

---

## Open questions

1. **ENVATO_REFERENCE_UUID stability.** The constant is seeded as the placeholder `'00000000-0000-0000-0000-000000000000'` in Task 3 — this MUST be replaced with a real stable Envato stock-video UUID before Task 10 Step 6 can pass. Candidates: any popular stock clip on `elements.envato.com/stock-video` that you've viewed once to confirm it redirects to `app.envato.com/<segment>/<UUID>`. Once picked, commit separately with a `chore(ext): set real ENVATO_REFERENCE_UUID` message so the history reflects the decision. Rotation path is documented inline. If this UUID gets delisted mid-lifetime, pre-flight degrades gracefully to `envato_preflight_error` (distinct from `envato_session_missing_preflight`) so ops can tell "ref rotated" from "user signed out."

2. **Single Port slot vs. multi-tab.** Ext.4 stores one active Port; a new connection displaces the previous. Per spec ("Single active run per user"), this is fine — but if the web app's export page is ever opened in two tabs (accidentally), the second connect will disconnect the first. Acceptable for MVP; Ext.5 can revisit if user testing surfaces a confused UX. No code rework needed yet.

3. **Test-page replying `{type:"session"}` via `sendMessage`.** The 401 refresh simulation (fieldset 9) relies on the user driving fieldset 2 to complete the round-trip. That works because `port.js` handles inbound `{type:"session"}` on ANY connected port — but the test page uses `sendMessage`, not the Port, in fieldset 2. A stricter test would require the test page to post the session via `activeTestPort.postMessage(...)` to match production; Ext.4's simulation is good enough for smoke verification. If we decide to tighten, add a button "Post {type:"session"} via Port" on fieldset 9 itself.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-24-extension-ext4-auth-polish.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks. Task 10's manual smoke stays with the human driver regardless.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints before Task 10.

Which approach?
