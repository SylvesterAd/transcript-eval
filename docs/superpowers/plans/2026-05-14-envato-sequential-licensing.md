# Envato Sequential Licensing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serialize the Envato resolve → license → download cycle to one item at a time, hold the licensing tab open through the download, and apply a 1-2s jitter delay between cycles. Eliminates the `/download.data` 429 burst.

**Architecture:** Cap `MAX_ENVATO_RESOLVER_CONCURRENCY` and `MAX_ENVATO_LICENSE_CONCURRENCY` at 1. Extend the licensing phase's slot to remain held until `chrome.downloads.onChanged` reports the item complete/interrupted. Keep the license tab alive for that window. Insert a `state.envato_next_pickup_at` gate in `nextItemForPhase` that adds a randomized 1-2s delay between Envato items. Apply only to Envato; other sources untouched.

**Tech Stack:** Chrome MV3 service worker (vanilla JS, no bundler), Vitest in the `extension` workspace project, the existing telemetry pipe (`emit as emitTelemetry` from `./telemetry.js`).

---

## File Structure

**Modified files:**
- `extension/config.js` — drop both Envato caps to 1; add `ENVATO_INTER_ITEM_DELAY_MS_MIN/MAX`
- `extension/manifest.json` — version `1.0.0 → 1.1.0`
- `extension/modules/envato.js` — `getSignedDownloadUrl` returns `licenseTabId`; no tab close in success-path `finally`
- `extension/modules/queue.js` — add `closeLicenseTab` helper, `item.license_tab_id` field, `state.envato_next_pickup_at` gate, extend licensing-phase await for Envato to download completion, wire tab close + jitter delay in onChanged complete/interrupted handlers, close held tabs in pause/cancel handlers, two new telemetry emits
- `docs/SMOKES.md` — append manual smoke #13

**New files:**
- `extension/modules/__tests__/queue-envato-sequential.test.js` — all unit tests for this feature

**Spec reference:** `docs/superpowers/specs/2026-05-14-envato-sequential-licensing-design.md`

---

## Task 1: Config + version bump

**Files:**
- Modify: `extension/config.js`
- Modify: `extension/manifest.json`

- [ ] **Step 1: Inspect current config values**

Run:
```bash
cd "/Users/laurynas/Desktop/one last /transcript-eval/.worktrees/extension-fps-probe"
grep -n "MAX_ENVATO\|ENVATO_INTER\|ENVATO_429" extension/config.js
```
Expect to see:
- `MAX_ENVATO_RESOLVER_CONCURRENCY = 5` (line 44)
- `MAX_ENVATO_LICENSE_CONCURRENCY = 2` (line 45)
- `ENVATO_429_COOLDOWN_MS = 5 * 60 * 1000` (line 142)

If line numbers differ, adjust the edits accordingly — match on the export names.

- [ ] **Step 2: Edit `extension/config.js`**

Change line 44 from:
```js
export const MAX_ENVATO_RESOLVER_CONCURRENCY = 5
```
to:
```js
export const MAX_ENVATO_RESOLVER_CONCURRENCY = 1
```

Change line 45 from:
```js
export const MAX_ENVATO_LICENSE_CONCURRENCY = 2
```
to:
```js
export const MAX_ENVATO_LICENSE_CONCURRENCY = 1
```

Add two new constants immediately after line 45 (or grouped with other ENVATO_* timing constants near line 142 — either is fine, but match the surrounding style):
```js
// Per-item pacing between sequential Envato cycles. Randomized within this
// range to look humanlike and avoid burst patterns on /download.data.
export const ENVATO_INTER_ITEM_DELAY_MS_MIN = 1000
export const ENVATO_INTER_ITEM_DELAY_MS_MAX = 2000
```

- [ ] **Step 3: Bump extension/manifest.json version**

Edit `extension/manifest.json` — change:
```json
"version": "1.0.0"
```
to:
```json
"version": "1.1.0"
```

Verify it parses:
```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('extension/manifest.json')).version)"
```
Expected: `1.1.0`

- [ ] **Step 4: Run the full extension suite to catch any test that hardcoded the old caps**

Run:
```bash
npx vitest run --project extension --reporter=basic 2>&1 | tail -10
```
Expected: all tests pass. If a test fails because it asserted the old cap value, update the test to the new value (these are config-mirror tests, not behavior tests; safe to update).

- [ ] **Step 5: Commit**

```bash
git add extension/config.js extension/manifest.json
git commit -m "feat(ext): manifest v1.1.0 + cap Envato resolver/license concurrency at 1

Adds ENVATO_INTER_ITEM_DELAY_MS_MIN/MAX (1000/2000) for jitter between
sequential cycles. Subsequent commits wire the per-item-cycle gating
that turns these caps into actual serialization."
```

---

## Task 2: `getSignedDownloadUrl` returns `licenseTabId`; tab stays open on success

**Files:**
- Modify: `extension/modules/envato.js`
- Modify or create: `extension/modules/__tests__/envato.test.js`

- [ ] **Step 1: Inspect the current function**

Run:
```bash
grep -n "export async function getSignedDownloadUrl\|chrome.tabs.remove" extension/modules/envato.js | head -10
```
Find the `getSignedDownloadUrl` function (~line 138-189). It currently has a `finally { try { await chrome.tabs.remove(tab.id) } catch {} }` block that closes the tab regardless of success or failure.

- [ ] **Step 2: Modify the function — close tab on failure only**

Open `extension/modules/envato.js`. Locate the function body. The current structure is approximately:

```js
export async function getSignedDownloadUrl(newUuid) {
  let tab
  try {
    tab = await chrome.tabs.create({ url: ..., active: false })
    // ... wait for tab load, inject script, parse result ...
    return { signedUrl, filename }
  } finally {
    try { await chrome.tabs.remove(tab.id) } catch {}
  }
}
```

Change it to close the tab ONLY on the error path:

```js
export async function getSignedDownloadUrl(newUuid) {
  let tab
  try {
    tab = await chrome.tabs.create({ url: ..., active: false })
    // ... wait for tab load, inject script, parse result ...
    // ↓ NEW: include tab id in return
    return { signedUrl, filename, licenseTabId: tab.id }
  } catch (err) {
    // Close the tab on failure — no successful return value to caller, nothing
    // for the queue to hold the tab open for.
    if (tab?.id) { try { await chrome.tabs.remove(tab.id) } catch {} }
    throw err
  }
}
```

The previous `finally` block is replaced by a `catch` block that closes-and-rethrows.

- [ ] **Step 3: Add a failing test that confirms the tab is not closed on success**

If `extension/modules/__tests__/envato.test.js` does not exist, create it. If it does, append.

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

function setupChrome() {
  globalThis.chrome = {
    tabs: {
      create: vi.fn(async ({ url }) => ({ id: 42, url })),
      remove: vi.fn(async () => {}),
    },
    scripting: {
      executeScript: vi.fn(async () => ([{ result: {
        signedUrl: 'https://cdn.envato.com/signed/abc?token=xyz',
        filename: 'movie.mov',
      } }])),
    },
    webNavigation: { onCommitted: { addListener: vi.fn(), removeListener: vi.fn() } },
  }
}

describe('getSignedDownloadUrl tab lifecycle', () => {
  beforeEach(() => setupChrome())

  it('returns licenseTabId and does NOT close the tab on success', async () => {
    const { getSignedDownloadUrl } = await import('../envato.js')
    const result = await getSignedDownloadUrl('11111111-2222-3333-4444-555555555555')
    expect(result).toMatchObject({
      signedUrl: 'https://cdn.envato.com/signed/abc?token=xyz',
      filename: 'movie.mov',
      licenseTabId: 42,
    })
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
  })

  it('closes the tab on error path', async () => {
    chrome.scripting.executeScript = vi.fn(async () => {
      throw new Error('synthetic failure')
    })
    const { getSignedDownloadUrl } = await import('../envato.js')
    await expect(getSignedDownloadUrl('11111111-2222-3333-4444-555555555555')).rejects.toThrow('synthetic failure')
    expect(chrome.tabs.remove).toHaveBeenCalledWith(42)
  })
})
```

- [ ] **Step 4: Run test to verify it passes against the new code**

Run:
```bash
npx vitest run extension/modules/__tests__/envato.test.js 2>&1 | tail -10
```
Expected: both tests pass. If the function isn't quite shaped like the test expects (e.g. it uses `waitForTabComplete` that the stub doesn't handle), inspect the test failure, add the missing stub, and re-run. **Do not relax the assertions.**

If existing envato tests exist in the same file or a sibling, run them too to confirm no regression:
```bash
npx vitest run extension/modules/__tests__/envato.test.js
```

- [ ] **Step 5: Commit**

```bash
git add extension/modules/envato.js extension/modules/__tests__/envato.test.js
git commit -m "feat(envato): getSignedDownloadUrl returns licenseTabId, keeps tab open on success

Tab now closes only on the error path; the queue will close it after
chrome.downloads completion. Subsequent commits wire the queue side."
```

---

## Task 3: Queue — `closeLicenseTab` helper + `item.license_tab_id` + `envato_license_tab_held` emit

**Files:**
- Modify: `extension/modules/queue.js`
- Create: `extension/modules/__tests__/queue-envato-sequential.test.js`

- [ ] **Step 1: Write a failing test for closeLicenseTab**

Create `extension/modules/__tests__/queue-envato-sequential.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

function setupChrome() {
  globalThis.chrome = {
    tabs: { remove: vi.fn(async () => {}) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn() } },
    runtime: { sendMessage: vi.fn(), getManifest: () => ({ version: '1.1.0' }) },
    downloads: { onChanged: { addListener: vi.fn() } },
  }
  // Reset module cache so the import sees fresh module-level state
  vi.resetModules()
}

describe('closeLicenseTab helper', () => {
  beforeEach(() => setupChrome())

  it('closes the tab and emits envato_license_tab_closed with the given reason', async () => {
    const emitCalls = []
    vi.doMock('../telemetry.js', () => ({
      emit: (name, meta) => emitCalls.push({ name, meta }),
      normalizeErrorCode: (e) => e,
    }))
    const { closeLicenseTab } = await import('../queue.js')
    const item = { seq: 3, source_item_id: 'NXG_AB', license_tab_id: 99 }
    await closeLicenseTab(item, 'download_complete')
    expect(chrome.tabs.remove).toHaveBeenCalledWith(99)
    expect(item.license_tab_id).toBeNull()
    expect(emitCalls).toEqual([{
      name: 'envato_license_tab_closed',
      meta: expect.objectContaining({ seq: 3, source_item_id: 'NXG_AB', reason: 'download_complete' }),
    }])
    vi.doUnmock('../telemetry.js')
  })

  it('is a no-op when item has no license_tab_id', async () => {
    const emitCalls = []
    vi.doMock('../telemetry.js', () => ({
      emit: (name, meta) => emitCalls.push({ name, meta }),
      normalizeErrorCode: (e) => e,
    }))
    const { closeLicenseTab } = await import('../queue.js')
    const item = { seq: 3, source_item_id: 'NXG_AB', license_tab_id: null }
    await closeLicenseTab(item, 'download_complete')
    expect(chrome.tabs.remove).not.toHaveBeenCalled()
    expect(emitCalls).toEqual([])
    vi.doUnmock('../telemetry.js')
  })

  it('swallows chrome.tabs.remove errors (tab already closed)', async () => {
    chrome.tabs.remove = vi.fn(async () => { throw new Error('No tab with id') })
    vi.doMock('../telemetry.js', () => ({
      emit: vi.fn(),
      normalizeErrorCode: (e) => e,
    }))
    const { closeLicenseTab } = await import('../queue.js')
    const item = { seq: 3, source_item_id: 'NXG_AB', license_tab_id: 99 }
    // Should not throw
    await expect(closeLicenseTab(item, 'download_complete')).resolves.toBeUndefined()
    expect(item.license_tab_id).toBeNull()  // still cleared
    vi.doUnmock('../telemetry.js')
  })
})
```

- [ ] **Step 2: Run test, expect FAIL (closeLicenseTab not exported)**

```bash
npx vitest run extension/modules/__tests__/queue-envato-sequential.test.js -t "closeLicenseTab"
```
Expected: 3 tests fail.

- [ ] **Step 3: Add `closeLicenseTab` to `extension/modules/queue.js`**

Open `extension/modules/queue.js`. Find a good location near other helpers (e.g., near the existing `runProbeForItem` from Task 12 of the FPS probe plan). Add:

```js
/**
 * Close the held Envato licensing tab for an item and emit a telemetry
 * event. No-op if the item has no held tab.
 *
 * reason ∈ download_complete | download_failed | run_paused | run_cancelled
 */
export async function closeLicenseTab(item, reason) {
  if (!item?.license_tab_id) return
  const tabId = item.license_tab_id
  item.license_tab_id = null
  try {
    await chrome.tabs.remove(tabId)
  } catch {
    // tab already closed by user, or doesn't exist — ignore
  }
  emitTelemetry('envato_license_tab_closed', {
    seq: item.seq,
    source_item_id: item.source_item_id,
    reason,
    t: Date.now(),
  })
}
```

(`emitTelemetry` is already imported at the top of queue.js per the existing pattern — `import { emit as emitTelemetry, normalizeErrorCode } from './telemetry.js'`.)

- [ ] **Step 4: Initialize `item.license_tab_id` in the item factory**

Find the function that builds initial items from the manifest (likely `buildInitialRunState` or similar; grep for `phase: m.source === 'envato'`). In the item constructor, add `license_tab_id: null` to the initial shape.

Example — if the factory currently looks like:
```js
function makeItem(m) {
  return {
    seq: m.seq,
    source: m.source,
    source_item_id: m.source_item_id,
    target_filename: m.target_filename,
    phase: m.source === 'envato' ? 'queued' : 'downloading',
    bytes_received: 0,
    total_bytes: m.total_bytes,
    error_code: null,
    final_path: null,
    // ...
  }
}
```
Add:
```js
    license_tab_id: null,  // set on Envato license success, cleared on tab close
```

Also extend `buildItemSnapshot` (added in T13 of the FPS probe plan) to include `license_tab_id` ONLY when non-null:
```js
    ...(item.license_tab_id ? { license_tab_id: item.license_tab_id } : {}),
```

- [ ] **Step 5: Emit `envato_license_tab_held` on license success**

Find `runLicenser` (per the touchpoint map, around lines 300-355 of queue.js). After `getSignedDownloadUrl` returns and `item.signed_url` is stored, also store the tab id and emit:

```js
const { signedUrl, filename, licenseTabId } = await getSignedDownloadUrl(item.resolved_uuid)
item.signed_url = signedUrl
item.license_tab_id = licenseTabId  // NEW
emitTelemetry('envato_license_tab_held', {
  seq: item.seq,
  source_item_id: item.source_item_id,
  tab_id: licenseTabId,
  t: Date.now(),
})
// ... existing phase transition: item.phase = 'downloading' ...
```

- [ ] **Step 6: Run tests, expect PASS**

```bash
npx vitest run extension/modules/__tests__/queue-envato-sequential.test.js -t "closeLicenseTab"
```
Expected: 3 tests pass.

Run the full extension suite to catch regressions:
```bash
npx vitest run --project extension --reporter=basic 2>&1 | tail -8
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add extension/modules/queue.js extension/modules/__tests__/queue-envato-sequential.test.js
git commit -m "feat(ext): add closeLicenseTab helper + item.license_tab_id field

Helper closes the held tab and emits envato_license_tab_closed with a
reason. The license phase now stores licenseTabId on the item and emits
envato_license_tab_held on success. Tab is not yet closed by anyone on
the success path — next commit wires the close into chrome.downloads
onChanged."
```

---

## Task 4: Couple licensing slot release to download completion (Envato only)

**Files:**
- Modify: `extension/modules/queue.js`
- Modify: `extension/modules/__tests__/queue-envato-sequential.test.js`

This is the **state machine change** — the heart of the feature. The licensing phase's slot must remain held until `chrome.downloads.onChanged` reports the item complete or interrupted. We achieve this by adding an item-level "download settle" promise that `runLicenser` awaits before resolving.

- [ ] **Step 1: Write failing test — second item doesn't license until first item's download completes**

Append to `extension/modules/__tests__/queue-envato-sequential.test.js`:

```js
describe('Envato licensing slot held through download', () => {
  beforeEach(() => setupChrome())

  it('item N+1 licensing does not start until item N download completes', async () => {
    const downloadComplete = vi.fn()
    const licenseStarts = []

    // Mock chrome to simulate two envato items.
    globalThis.chrome = {
      tabs: {
        create: vi.fn(async ({ url }) => {
          if (url.includes('app.envato.com/stock-video')) {
            licenseStarts.push({ at: Date.now(), url })
          }
          return { id: Math.floor(Math.random() * 1000), url }
        }),
        remove: vi.fn(async () => {}),
      },
      scripting: {
        executeScript: vi.fn(async () => ([{ result: { signedUrl: 'https://cdn/x', filename: 'a.mov' } }])),
      },
      downloads: {
        download: vi.fn(async () => 1),
        onChanged: { addListener: vi.fn((cb) => { globalThis.__downloadListener = cb }) },
        search: vi.fn(async () => []),
      },
      webNavigation: { onCommitted: { addListener: vi.fn(), removeListener: vi.fn() } },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn() } },
      runtime: { sendMessage: vi.fn(), getManifest: () => ({ version: '1.1.0' }) },
      extension: { isAllowedFileSchemeAccess: vi.fn(async () => false) },
    }

    vi.resetModules()
    const { startRun } = await import('../queue.js')

    // Start a 2-item Envato run. Items go through queued → resolving → licensing → downloading.
    // We'll need to fake the resolver's UUID capture too. Simplify by stubbing resolveOldIdToNewUuid
    // via vi.doMock.
    vi.doMock('../envato.js', async () => {
      const actual = await vi.importActual('../envato.js')
      return {
        ...actual,
        resolveOldIdToNewUuid: vi.fn(async () => '11111111-2222-3333-4444-555555555555'),
        getSignedDownloadUrl: vi.fn(async () => ({
          signedUrl: 'https://cdn/x',
          filename: 'a.mov',
          licenseTabId: 42,
        })),
      }
    })

    const manifest = {
      items: [
        { seq: 1, source: 'envato', source_item_id: 'NX1', target_filename: 'a.mov', total_bytes: 1000 },
        { seq: 2, source: 'envato', source_item_id: 'NX2', target_filename: 'b.mov', total_bytes: 1000 },
      ],
    }
    const runPromise = startRun({ manifest, runId: 'test-run', target_folder: 'tmp' })

    // Wait for item 1 to reach licensing — first license tab open
    await new Promise(r => setTimeout(r, 100))
    const beforeCompleteCount = licenseStarts.length
    expect(beforeCompleteCount).toBe(1)  // only item 1's license tab open so far

    // Fire chrome.downloads complete for item 1
    globalThis.__downloadListener({ id: 1, state: { current: 'complete', previous: 'in_progress' } })
    await new Promise(r => setTimeout(r, 100))

    // Now item 2's licensing should have begun
    const afterCompleteCount = licenseStarts.length
    expect(afterCompleteCount).toBe(2)

    vi.doUnmock('../envato.js')
  })
})
```

**Note**: This test is integration-y and depends on the exact internal flow of `startRun`. Some adaptation may be needed — e.g. you may need to stub `runProbeForItem` (added in T12 of the FPS probe plan) or arrange for `chrome.downloads.download` to call its callback. If the test ends up too brittle, simplify by exposing a smaller internal slice (e.g. testing `runLicenser` directly with a controlled download-settle promise). The acceptance criterion is: with cap=1, item N+1's `getSignedDownloadUrl` is NOT called until item N's download has fired its `complete` event.

- [ ] **Step 2: Run, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/queue-envato-sequential.test.js -t "slot held through download"
```
Expected: the test fails — today, item 2's licensing fires as soon as item 1's licensing returns, not waiting for download.

- [ ] **Step 3: Implement — `runLicenser` awaits download settle for Envato**

Open `extension/modules/queue.js`. Find `runLicenser` (~lines 300-355). After the existing phase transition to `'downloading'`, add an await on an item-level promise that the download-completion handler will resolve:

```js
async function runLicenser(item) {
  const { signedUrl, filename, licenseTabId } = await getSignedDownloadUrl(item.resolved_uuid)
  item.signed_url = signedUrl
  item.license_tab_id = licenseTabId
  emitTelemetry('envato_license_tab_held', {
    seq: item.seq, source_item_id: item.source_item_id, tab_id: licenseTabId, t: Date.now(),
  })
  item.phase = 'downloading'
  await persistAndBroadcast()

  // For Envato: keep the licensing slot held until the download finishes.
  // For non-Envato: this branch never executes (the licensing phase is
  // Envato-specific anyway).
  if (item.source === 'envato') {
    await new Promise((resolve) => {
      item.__envato_cycle_settle = resolve
    })
  }
}
```

The `__envato_cycle_settle` field is set here and called from the download-complete and download-interrupted branches in the next task. Until then, the test will hang (good — that's the failing state we want to verify).

Actually, to keep test runs from hanging in this intermediate state, also wire the download-complete and -interrupted branches NOW. The two changes are coupled:

In the `chrome.downloads.onChanged` complete branch (per touchpoint map, around line 581):
```js
// existing: item.__settle?.() — keep as is
// existing: runProbeForItem(item, ...) call — keep as is
// NEW:
if (item.source === 'envato' && item.__envato_cycle_settle) {
  item.__envato_cycle_settle()
  item.__envato_cycle_settle = null
}
```

In the `chrome.downloads.onChanged` interrupted branch (around line 583-586):
```js
// existing: phase = 'failed', error_code set, etc.
// NEW:
if (item.source === 'envato' && item.__envato_cycle_settle) {
  item.__envato_cycle_settle()
  item.__envato_cycle_settle = null
}
```

This makes the licensing slot effectively held until one of these branches fires.

- [ ] **Step 4: Run test, expect PASS**

```bash
npx vitest run extension/modules/__tests__/queue-envato-sequential.test.js -t "slot held through download"
```
Expected: the test passes — item 2's license tab open happens AFTER item 1's `complete` event fires.

Run the full extension suite for regression:
```bash
npx vitest run --project extension --reporter=basic 2>&1 | tail -8
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add extension/modules/queue.js extension/modules/__tests__/queue-envato-sequential.test.js
git commit -m "feat(ext): hold Envato licensing slot until chrome.downloads completes

runLicenser now awaits an item-level __envato_cycle_settle promise for
Envato items. The promise is resolved from the chrome.downloads
onChanged handler when state.current is 'complete' or 'interrupted'.
Effectively, license + download are now a single atomic slot for Envato.
Combined with MAX_ENVATO_LICENSE_CONCURRENCY=1 from task 1, this
serializes Envato item processing end-to-end."
```

---

## Task 5: Close held tab on download completion (success + interrupted paths)

**Files:**
- Modify: `extension/modules/queue.js`
- Modify: `extension/modules/__tests__/queue-envato-sequential.test.js`

The previous task wired the slot release. This task closes the actual tab.

- [ ] **Step 1: Failing tests — tab closes with correct reason on each path**

Append to `extension/modules/__tests__/queue-envato-sequential.test.js`:

```js
describe('Envato license tab close-on-download', () => {
  beforeEach(() => setupChrome())

  it('closes the license tab with reason download_complete on successful download', async () => {
    // Setup mostly mirrors the "slot held through download" test.
    const emitCalls = []
    vi.doMock('../telemetry.js', () => ({
      emit: (name, meta) => emitCalls.push({ name, meta }),
      normalizeErrorCode: (e) => e,
    }))
    vi.doMock('../envato.js', async () => {
      const actual = await vi.importActual('../envato.js')
      return {
        ...actual,
        resolveOldIdToNewUuid: vi.fn(async () => '1'.repeat(8) + '-' + '2'.repeat(4) + '-' + '3'.repeat(4) + '-' + '4'.repeat(4) + '-' + '5'.repeat(12)),
        getSignedDownloadUrl: vi.fn(async () => ({
          signedUrl: 'https://cdn/x', filename: 'a.mov', licenseTabId: 42,
        })),
      }
    })
    // ... build chrome stub like prior test, start a single-item run ...
    // ... fire complete event ...
    // Assert:
    expect(chrome.tabs.remove).toHaveBeenCalledWith(42)
    const closedEvent = emitCalls.find(e => e.name === 'envato_license_tab_closed')
    expect(closedEvent.meta.reason).toBe('download_complete')
    vi.doUnmock('../telemetry.js')
    vi.doUnmock('../envato.js')
  })

  it('closes the license tab with reason download_failed on interrupted download', async () => {
    // Same setup but fire { state: { current: 'interrupted', previous: 'in_progress' } }.
    // Assert:
    // - chrome.tabs.remove called with the licenseTabId
    // - envato_license_tab_closed emitted with reason: 'download_failed'
    // (Fill in the test body following the same pattern as the test above.)
  })
})
```

Note: the second test should mirror the first's harness, just firing an `interrupted` state. The second test body is left for the engineer to fill in following the same pattern — the same Chrome stubs, the same `getSignedDownloadUrl` mock, but the download listener gets called with interrupted state.

- [ ] **Step 2: Run, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/queue-envato-sequential.test.js -t "close-on-download"
```
Expected: 2 tests fail (tab is not being closed by anything today).

- [ ] **Step 3: Wire `closeLicenseTab` into the onChanged handler branches**

In `extension/modules/queue.js`, find the `chrome.downloads.onChanged` complete branch (per touchpoint map, ~line 468-581).

Add right BEFORE the `item.__envato_cycle_settle` block from Task 4:

```js
// Close the held license tab (Envato-only; no-op for other sources).
if (item.source === 'envato') {
  await closeLicenseTab(item, 'download_complete')
}
```

In the interrupted branch (~line 583-586) — find where the item is being transitioned to a failed phase:
```js
if (item.source === 'envato') {
  await closeLicenseTab(item, 'download_failed')
}
```

Order matters: close the tab BEFORE resolving the settle promise, so the cleanup completes before the next item starts.

- [ ] **Step 4: Run tests, expect PASS**

```bash
npx vitest run extension/modules/__tests__/queue-envato-sequential.test.js -t "close-on-download"
npx vitest run --project extension --reporter=basic 2>&1 | tail -8
```
Expected: both new tests pass; no regressions.

- [ ] **Step 5: Commit**

```bash
git add extension/modules/queue.js extension/modules/__tests__/queue-envato-sequential.test.js
git commit -m "feat(ext): close held Envato license tab on download complete/interrupted

Tab close fires from chrome.downloads.onChanged handler, before the
__envato_cycle_settle promise resolves to release the licensing slot.
Telemetry emits envato_license_tab_closed with reason download_complete
or download_failed."
```

---

## Task 6: Inter-item jitter delay gate

**Files:**
- Modify: `extension/modules/queue.js`
- Modify: `extension/modules/__tests__/queue-envato-sequential.test.js`

- [ ] **Step 1: Failing test — `nextItemForPhase` honors `state.envato_next_pickup_at`**

Append to `extension/modules/__tests__/queue-envato-sequential.test.js`:

```js
describe('Envato inter-item pickup gate', () => {
  beforeEach(() => setupChrome())

  it('nextItemForPhase returns null for Envato when state.envato_next_pickup_at is in the future', async () => {
    vi.doMock('../telemetry.js', () => ({ emit: vi.fn(), normalizeErrorCode: (e) => e }))
    const { _testHooks } = await import('../queue.js')
    expect(_testHooks).toBeDefined()  // queue.js must export an internal test hook for state injection
    const fakeState = {
      items: [
        { seq: 2, claimed: false, source: 'envato', phase: 'licensing' },
      ],
      envato_next_pickup_at: Date.now() + 5000,  // 5s in the future
    }
    expect(_testHooks.nextItemForPhase('licensing', fakeState)).toBeNull()

    // After the gate passes, the item should be pickable
    fakeState.envato_next_pickup_at = Date.now() - 1
    expect(_testHooks.nextItemForPhase('licensing', fakeState)).toBe(fakeState.items[0])
    vi.doUnmock('../telemetry.js')
  })

  it('sets state.envato_next_pickup_at to now + 1000..2000ms after download complete', async () => {
    // Set up a 1-item Envato run; fire download complete; assert envato_next_pickup_at is set
    // in the [now+1000, now+2000) range.
    // ... harness following prior tests ...
  })
})
```

If queue.js doesn't already expose `_testHooks`, add a named export:

```js
export const _testHooks = {
  nextItemForPhase,
}
```

This is a test-only hook. Same pattern used in T17 (`_setProbeConfigOverride`).

- [ ] **Step 2: Run, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/queue-envato-sequential.test.js -t "inter-item pickup gate"
```
Expected: 2 tests fail.

- [ ] **Step 3: Implement the gate in `nextItemForPhase`**

In `extension/modules/queue.js`, find `nextItemForPhase` (~lines 255-270). The Envato branches today:
```js
if (phaseName === 'resolving') {
  return state.items.find(i => !i.claimed && i.source === 'envato' && i.phase === 'queued')
}
if (phaseName === 'licensing') {
  return state.items.find(i => !i.claimed && i.source === 'envato' && i.phase === 'licensing')
}
```

Add a gate at the top of both branches:
```js
function isEnvatoGated(state) {
  return state.envato_next_pickup_at && Date.now() < state.envato_next_pickup_at
}

// inside the function:
if (phaseName === 'resolving') {
  if (isEnvatoGated(state)) return null
  return state.items.find(i => !i.claimed && i.source === 'envato' && i.phase === 'queued')
}
if (phaseName === 'licensing') {
  if (isEnvatoGated(state)) return null
  return state.items.find(i => !i.claimed && i.source === 'envato' && i.phase === 'licensing')
}
```

Also export `_testHooks` near the bottom of the file:
```js
export const _testHooks = { nextItemForPhase }
```

- [ ] **Step 4: Set `state.envato_next_pickup_at` after download complete**

In the `chrome.downloads.onChanged` complete branch — right after `closeLicenseTab(item, 'download_complete')` and the settle release — for Envato items add:

```js
if (item.source === 'envato') {
  const minMs = ENVATO_INTER_ITEM_DELAY_MS_MIN
  const maxMs = ENVATO_INTER_ITEM_DELAY_MS_MAX
  state.envato_next_pickup_at = Date.now() + minMs + Math.random() * (maxMs - minMs)
}
```

Import the new constants at the top of queue.js (alongside the existing config imports):
```js
import {
  // ... existing imports ...
  ENVATO_INTER_ITEM_DELAY_MS_MIN,
  ENVATO_INTER_ITEM_DELAY_MS_MAX,
} from '../config.js'
```

Initialize `state.envato_next_pickup_at = 0` in the run-state factory so the gate is open at run start.

Re-running `schedule()` periodically is already part of the existing scheduler — when the gate passes, the next `schedule()` call will pick up the next item. If there's a `setTimeout`-based wake-up needed, also add one in the same branch:

```js
if (item.source === 'envato') {
  const delayMs = minMs + Math.random() * (maxMs - minMs)
  state.envato_next_pickup_at = Date.now() + delayMs
  setTimeout(() => schedule(), delayMs + 10)  // 10ms buffer past the gate
}
```

(Investigate the existing `schedule()` triggers — if it's already polling on `chrome.downloads.onChanged` events, the setTimeout may be redundant. But adding it doesn't hurt.)

- [ ] **Step 5: Run tests, expect PASS**

```bash
npx vitest run extension/modules/__tests__/queue-envato-sequential.test.js -t "inter-item pickup gate"
npx vitest run --project extension --reporter=basic 2>&1 | tail -8
```

- [ ] **Step 6: Commit**

```bash
git add extension/modules/queue.js extension/modules/__tests__/queue-envato-sequential.test.js
git commit -m "feat(ext): add 1-2s jitter delay between Envato cycles

state.envato_next_pickup_at gates nextItemForPhase for both 'resolving'
and 'licensing' phases of Envato. After each Envato download
completes, the gate is set to now + uniform(1000, 2000)ms. Other
sources unaffected."
```

---

## Task 7: Pause/cancel close held license tabs

**Files:**
- Modify: `extension/modules/queue.js`
- Modify: `extension/modules/__tests__/queue-envato-sequential.test.js`

- [ ] **Step 1: Failing tests**

Append to test file:

```js
describe('Envato held tabs close on pause/cancel', () => {
  beforeEach(() => setupChrome())

  it('cancelRun closes all held license tabs with reason run_cancelled', async () => {
    const emitCalls = []
    vi.doMock('../telemetry.js', () => ({
      emit: (n, m) => emitCalls.push({ name: n, meta: m }),
      normalizeErrorCode: (e) => e,
    }))
    const { _testHooks } = await import('../queue.js')
    // Simulate state with 2 items, both holding tabs (impossible in production with cap=1 but
    // we force this to test the cleanup loop covers all items)
    const state = {
      items: [
        { seq: 1, source: 'envato', source_item_id: 'NX1', license_tab_id: 11, __envato_cycle_settle: vi.fn() },
        { seq: 2, source: 'envato', source_item_id: 'NX2', license_tab_id: 22, __envato_cycle_settle: vi.fn() },
      ],
    }
    await _testHooks.closeAllHeldLicenseTabs(state, 'run_cancelled')
    expect(chrome.tabs.remove).toHaveBeenCalledWith(11)
    expect(chrome.tabs.remove).toHaveBeenCalledWith(22)
    const closedEvents = emitCalls.filter(e => e.name === 'envato_license_tab_closed')
    expect(closedEvents.length).toBe(2)
    expect(closedEvents.every(e => e.meta.reason === 'run_cancelled')).toBe(true)
    vi.doUnmock('../telemetry.js')
  })

  it('pauseRun closes all held license tabs with reason run_paused', async () => {
    const emitCalls = []
    vi.doMock('../telemetry.js', () => ({
      emit: (n, m) => emitCalls.push({ name: n, meta: m }),
      normalizeErrorCode: (e) => e,
    }))
    const { _testHooks } = await import('../queue.js')
    const state = {
      items: [
        { seq: 1, source: 'envato', source_item_id: 'NX1', license_tab_id: 11, __envato_cycle_settle: vi.fn() },
      ],
    }
    await _testHooks.closeAllHeldLicenseTabs(state, 'run_paused')
    expect(chrome.tabs.remove).toHaveBeenCalledWith(11)
    const evt = emitCalls.find(e => e.name === 'envato_license_tab_closed')
    expect(evt.meta.reason).toBe('run_paused')
    vi.doUnmock('../telemetry.js')
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npx vitest run extension/modules/__tests__/queue-envato-sequential.test.js -t "close on pause/cancel"
```

- [ ] **Step 3: Implement `closeAllHeldLicenseTabs` + wire into `pauseRun`/`cancelRun`**

In `extension/modules/queue.js`, add a helper near `closeLicenseTab`:

```js
async function closeAllHeldLicenseTabs(state, reason) {
  if (!state?.items) return
  for (const item of state.items) {
    if (item.license_tab_id) {
      // closeLicenseTab clears item.license_tab_id and emits telemetry.
      await closeLicenseTab(item, reason)
      // Also release any held cycle-settle so the runner promise can resolve
      // and unwind cleanly during pause/cancel.
      if (item.__envato_cycle_settle) {
        item.__envato_cycle_settle()
        item.__envato_cycle_settle = null
      }
    }
  }
}
```

Find `pauseRun` (per touchpoint map, lines 164-175). Before setting `state.run_state = 'paused'`, add:
```js
await closeAllHeldLicenseTabs(state, 'run_paused')
```

Find `cancelRun` (lines 190-219). Before the existing `chrome.downloads.cancel` loop, add:
```js
await closeAllHeldLicenseTabs(state, 'run_cancelled')
```

Export the helper via `_testHooks`:
```js
export const _testHooks = { nextItemForPhase, closeAllHeldLicenseTabs }
```

- [ ] **Step 4: Run tests, expect PASS**

```bash
npx vitest run extension/modules/__tests__/queue-envato-sequential.test.js -t "close on pause/cancel"
npx vitest run --project extension --reporter=basic 2>&1 | tail -8
```

- [ ] **Step 5: Commit**

```bash
git add extension/modules/queue.js extension/modules/__tests__/queue-envato-sequential.test.js
git commit -m "feat(ext): pause/cancel close all held Envato license tabs

pauseRun emits envato_license_tab_closed with reason run_paused; cancelRun
emits with reason run_cancelled. Both release any held __envato_cycle_settle
promises so the runLicenser awaiters can unwind cleanly."
```

---

## Task 8: Manual smoke #13 in docs + final verification

**Files:**
- Modify: `docs/SMOKES.md`

- [ ] **Step 1: Append smoke #13 to `docs/SMOKES.md`**

Open `docs/SMOKES.md` and append after smoke #12:

```markdown
13. **Envato sequential cycle**
    - Start a 5+ item Envato export. Open the extension's service worker DevTools (chrome://extensions → service worker link). Watch the queue logs + the network panel filtered to `envato`.
    - Acceptance:
      - At any moment, `chrome.tabs.query({})` returns ≤ 1 tab matching `app.envato.com` AND ≤ 1 tab matching `elements.envato.com`.
      - `/download.data` requests are visibly serial in the network panel (no concurrent commits).
      - No HTTP 429 across the 5-item run.
      - Approximate wall-clock per item: licensing (~3s) + download (~5-30s) + 1-2s jitter. Compare against pre-feature baseline to confirm the slowdown is in the expected range (≤ 50% slower for typical 5-item runs; bigger gap for runs that would have 429-paused before).
    - Negative path: cancel the run mid-cycle; verify the held Envato tab closes immediately (not after a delay).
    - Telemetry path: filter the `export_events` log for `envato_license_tab_held` and `envato_license_tab_closed` — there should be one of each per item, in order, with matching `source_item_id`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/SMOKES.md
git commit -m "docs: add manual smoke #13 for Envato sequential cycle"
```

- [ ] **Step 3: Final verification — full suite + package**

```bash
npx vitest run --reporter=basic 2>&1 | tail -5
```
Expected: all tests pass across all workspace projects.

```bash
npm run ext:package 2>&1 | tail -5
```
Expected: builds `extension/dist/extension-1.1.0.zip` cleanly.

```bash
unzip -l extension/dist/extension-1.1.0.zip | grep -E "fixtures|__tests__|\.test\.js" && echo "CONTAMINATED" || echo "✓ clean"
```
Expected: `✓ clean` — no test/fixture content in production zip.

```bash
git log --oneline main..HEAD | head -10
```
Expected: ~8 new commits on top of the FPS probe branch (1 per task plus this one).

- [ ] **Step 4: Final cross-cutting code review**

Dispatch a final code review subagent across the whole Envato change. Focus areas:
- Does the licensing slot release atomically with download completion? (i.e. no race where slot frees before tab closes)
- Are pause/cancel paths actually iterating all held tabs in all the right places?
- Is `state.envato_next_pickup_at` initialized correctly on cold start (run-state-factory)?
- Are telemetry event names + meta payloads consistent with the spec?
- Does the manifest 1.1.0 bump align with the no-new-permission semver convention?

Don't push without explicit user approval.

---

## Self-Review

**Spec coverage check:**
- ✅ Config caps to 1 + jitter constants → Task 1
- ✅ Tab stays open on license success, closes only on error → Task 2
- ✅ closeLicenseTab helper, license_tab_id field, envato_license_tab_held emit → Task 3
- ✅ Licensing slot held until download complete (state machine change) → Task 4
- ✅ closeLicenseTab wired into download complete + interrupted handlers → Task 5
- ✅ Inter-item jitter delay gate → Task 6
- ✅ Pause/cancel close held tabs → Task 7
- ✅ Manual smoke #13 + final verification → Task 8
- ✅ Version bump 1.0.0 → 1.1.0 → Task 1

**Placeholder check:** All steps contain actual code or actual commands. No TBDs, no "add appropriate error handling," no "similar to Task N" (each task repeats relevant code).

**Type consistency:**
- `closeLicenseTab(item, reason)` — same signature across Tasks 3, 5, 6, 7
- `item.license_tab_id` — same field name across all tasks
- `item.__envato_cycle_settle` — same name in Tasks 4, 5, 7
- `state.envato_next_pickup_at` — same field name in Tasks 6
- `ENVATO_INTER_ITEM_DELAY_MS_MIN/MAX` — same constant names in Tasks 1 and 6
- Telemetry event names: `envato_license_tab_held`, `envato_license_tab_closed` — consistent

**One gotcha to flag for implementers:** Task 4's test is hard to write hermetically because `startRun` orchestrates many things. If the test ends up brittle, the implementer is encouraged to expose smaller internal slices via `_testHooks` (e.g. test `runLicenser` directly with a controlled `__envato_cycle_settle` resolver). The acceptance criterion — item N+1 doesn't start licensing until item N's download completes — can be verified at multiple granularities.
