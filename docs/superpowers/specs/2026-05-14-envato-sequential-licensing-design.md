# Sequential Envato Licensing + Download Cycle — Design

**Date:** 2026-05-14
**Branch:** stacked on `feature/extension-fps-probe`
**Status:** Design

## Problem

Envato exports get rate-limited (HTTP 429 on `/download.data`). The extension today opens up to **two licensing tabs concurrently** (`MAX_ENVATO_LICENSE_CONCURRENCY = 2`), each immediately fetching `/download.data` to commit the license. Two commits in milliseconds look like an automated burst to Envato's rate limiter, which returns 429 on the second one and triggers the existing 5-minute global queue pause (`ENVATO_429_COOLDOWN_MS`). After cooldown the run resumes, retries once, may 429 again → hard stop.

The licensing tab today *also* closes inside `getSignedDownloadUrl`'s `finally` block — before `chrome.downloads.download()` is even called. There's no human-like pacing between Envato cycles: license N+1 begins the instant license N returns the signed URL.

## Goal

Serialize the entire Envato per-item cycle (resolve → license → download) to a single in-flight item at a time, keep the licensing tab alive through the download as natural inter-item pacing, and add a 1-2s jitter delay between cycles. Eliminate the 429 burst at its root by ensuring only one `/download.data` commit per Envato wall-clock window.

## Current State

- **Three phases per Envato item** (per `extension/modules/queue.js` and `envato.js`):
  1. **Resolving** — opens hidden tab on `elements.envato.com/<slug>`, captures UUID redirect via `chrome.webNavigation.onCommitted`, closes tab. Cap 5.
  2. **Licensing** — opens hidden tab on `app.envato.com/stock-video/<uuid>`, injects content script that fetches `/download.data`, gets signed URL, **closes tab in `finally`**. Cap 2.
  3. **Downloading** — `chrome.downloads.download()` with the signed URL. Cap 3 (shared with other sources). **No tab during download.**
- **Concurrency model** (`queue.js` lines 243-252, `fillPool`): each phase has its own slot pool; slots free immediately when the phase's worker promise resolves.
- **429 handling** (`classifier.js`): first 429 retries after Retry-After + jitter; second 429 triggers `ENVATO_429_COOLDOWN_MS` (5 min) global pause; third 429 hard-stops the item.
- **Other sources** (Pexels, Freepik, A-roll): no licensing phase, no tabs — direct `chrome.downloads.download()` against the source URL.

## Approach: Full Serialization (chosen)

Cap both resolver AND licenser concurrency at 1. Hold the licensing tab open through the chrome.downloads completion of its item. Add 1-2s jitter delay between cycles. Apply only to Envato; other sources untouched.

Pros: matches "open → download → finish → close → next" mental model literally; only one Envato tab open at any moment, for any phase; maximally humanlike pacing.
Cons: slower wall-clock for large Envato exports (no parallelism on Envato; downloads still parallelize across sources). Acceptable per spec: slow + working > fast + blocked.

Alternative considered (Light serialization, cap resolver=5, cap licenser=1): rejected by user — they want full per-item serialization, including resolver, for tab-open-at-a-time guarantee.

## Architecture

The queue scheduler treats the Envato item lifecycle as an atomic slot. Cap 1 on the resolver AND license phases. When licensing returns, the licensing slot remains BUSY until `chrome.downloads.onChanged` reports the item's download as complete or failed. Only then is the slot freed, the held license tab closed, and (after a 1-2s jitter delay) the next Envato item picked up. Pexels, Freepik, and A-roll concurrency are unchanged.

```
Today's Envato item flow:                 New Envato item flow:
queued                                     queued
  ↓ (cap 5)                                  ↓ (cap 1)
resolving                                  resolving
  ↓                                          ↓
licensing                                  licensing
  ↓ (cap 2)                                  ↓ (cap 1)
[license tab closes in finally]            [license tab HELD]
  ↓                                          ↓
downloading                                downloading
  ↓ (cap 3, shared)                          ↓ (cap 3, shared)
done                                       [license tab closes]
                                             ↓
                                           [jitter delay 1-2s]
                                             ↓
                                           done
```

## Config Changes — `extension/config.js`

```diff
- export const MAX_ENVATO_RESOLVER_CONCURRENCY = 5
- export const MAX_ENVATO_LICENSE_CONCURRENCY = 2
+ export const MAX_ENVATO_RESOLVER_CONCURRENCY = 1
+ export const MAX_ENVATO_LICENSE_CONCURRENCY = 1
+ export const ENVATO_INTER_ITEM_DELAY_MS_MIN = 1000
+ export const ENVATO_INTER_ITEM_DELAY_MS_MAX = 2000
```

## State Machine Change — `extension/modules/queue.js`

The license phase slot release is no longer triggered by `getSignedDownloadUrl` returning. It's triggered by `chrome.downloads.onChanged` reporting the item's download as `complete` or `interrupted` (any terminal state). This is a behavior change ONLY for Envato items; non-Envato items don't pass through the licensing phase.

Implementation:
- `active.licensing--` moves from inside `getSignedDownloadUrl().finally(...)` to inside the chrome.downloads complete/interrupted handler, gated by `if (item.source === 'envato')`.
- The license phase's `runner` no longer auto-resolves at license-success; instead it returns a promise that resolves at download complete/fail.
- Effective coupling: licensing + downloading become a single atomic slot for Envato.

## Tab Lifecycle Change — `extension/modules/envato.js::getSignedDownloadUrl`

```diff
- } finally {
-   if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {})
- }
+ // Tab NOT closed here on success. Caller (queue) holds it through
+ // the download and closes via closeLicenseTab(tabId) when
+ // chrome.downloads reports complete/error.
+ // On THROWN error (no URL to return), close immediately —
+ // nothing to hold the tab open for.
```

Return shape gains `licenseTabId`:
```diff
- return { signedUrl, filename }
+ return { signedUrl, filename, licenseTabId: tab.id }
```

## Queue Plumbing — `extension/modules/queue.js`

New per-item field: `item.license_tab_id`. Set when license succeeds, cleared when tab is closed.

New helper:
```js
async function closeLicenseTab(item, reason) {
  if (!item?.license_tab_id) return
  const tabId = item.license_tab_id
  item.license_tab_id = null
  try {
    await chrome.tabs.remove(tabId)
    emit('envato_license_tab_closed', { seq: item.seq, source_item_id: item.source_item_id, reason })
  } catch {
    // tab already closed by user or never existed
  }
}
```

Wire points:
1. **`chrome.downloads.onChanged` complete branch** (alongside T12's `runProbeForItem` call): `closeLicenseTab(item, 'download_complete')`, then set `state.envato_next_pickup_at`.
2. **`chrome.downloads.onChanged` interrupted branch**: `closeLicenseTab(item, 'download_failed')`. No jitter delay (next item should retry promptly).
3. **Run pause handler**: iterate items with `license_tab_id`, close all with reason `run_paused`. On resume, items in `licensing` or earlier re-license from scratch; items in `downloading` use existing Ext.5 reconciliation.
4. **Run cancel handler**: iterate, close all with reason `run_cancelled`.

Existing emit on license success:
```js
emit('envato_license_tab_held', { seq: item.seq, source_item_id: item.source_item_id, tab_id: licenseTabId })
```

## Jitter Delay

After Envato item N's tab closes via `download_complete`, the scheduler sets:
```js
state.envato_next_pickup_at = Date.now() +
  ENVATO_INTER_ITEM_DELAY_MS_MIN +
  Math.random() * (ENVATO_INTER_ITEM_DELAY_MS_MAX - ENVATO_INTER_ITEM_DELAY_MS_MIN)
```

In `nextItemForPhase` for Envato phases (`resolving`, `licensing`), check `Date.now() < state.envato_next_pickup_at` and return null if so. The existing periodic `schedule()` re-runs (and any inbound event that triggers `schedule()`) will naturally pick up the item once the gate passes.

No delay on download-failed path (next item should retry promptly; the 429 path uses its own existing cooldown).

## Error Handling

| Path | Tab closes? | Slot frees? | Delay applied? |
|---|---|---|---|
| License throws (network / 401 / no signed URL) | yes, immediately in catch | yes (today's behavior — slot was held by license phase only) | no |
| License succeeds, `chrome.downloads.download()` throws synchronously | yes, in caller's catch | yes | no |
| Download completes (`state.current === 'complete'`) | yes, in onChanged handler | yes | yes (1-2s) |
| Download interrupted | yes, in onChanged handler | yes | no |
| Download paused by user via Chrome UI | no — tab and slot stay until user resumes or cancels | no | n/a |
| Run paused (user OR Ext.7 cooldown) | yes — all held tabs closed | yes | n/a |
| Run cancelled | yes — cleanup loop | yes | n/a |
| Service worker restart mid-cycle | irrelevant (SW death drops refs; tabs likely die too) | re-initialized to 0 | n/a; on resume, existing Ext.5 reconciliation applies |
| `closeLicenseTab` throws (tab already closed) | no-op (try/catch) | yes | applies normally |

## Telemetry Events

Two new events on the existing `emit()` pipe:

| Event | Meta | Emitted when |
|---|---|---|
| `envato_license_tab_held` | `{seq, source_item_id, tab_id}` | license success, tab retained for download |
| `envato_license_tab_closed` | `{seq, source_item_id, reason}` — reason ∈ `download_complete \| download_failed \| run_paused \| run_cancelled` | tab actually closed |

No event for the jitter delay itself (predictable from event timestamps).

## Tests

### Unit — `extension/modules/__tests__/queue-envato-sequential.test.js` (new file)

Each test stubs `chrome.tabs`, `chrome.downloads`, `chrome.scripting`, `chrome.webNavigation`, `chrome.storage.local` to drive the lifecycle deterministically.

1. **Single tab open at any moment.** With 3 Envato items queued, simulate the run end-to-end. Assert `chrome.tabs.create` calls minus `chrome.tabs.remove` calls is ≤ 1 at every observed wall-clock tick.
2. **Item N+1 licensing waits for item N download complete.** Drive item 1 to `chrome.downloads.onChanged` state `complete`. Assert item 2's `getSignedDownloadUrl` invocation happens AFTER (not before) item 1's tab is closed.
3. **License tab closes with reason `download_complete` on happy path.** Assert telemetry event fires with the expected reason.
4. **License tab closes with reason `download_failed` on interrupted download.**
5. **Inter-item jitter delay is in [1000, 2000) ms.** Mock `Date.now` and `Math.random` to make deterministic; assert scheduler's pickup respects `state.envato_next_pickup_at`.
6. **Run cancel closes all held license tabs.**
7. **Resolver cap=1 — only one resolver tab in flight at a time.** With 3 items queued, assert `chrome.tabs.create` for `elements.envato.com` URLs is serialized.

### Integration test — `queue-probe.test.js` or new file

3-item Envato run, end-to-end ordering of `state.items[i].phase` transitions matches strict sequential per item.

### Manual smoke #13 — `docs/SMOKES.md`

Start a 5+ item Envato export with the service worker DevTools open. Watch `chrome.tabs.query({})` periodically (or via the Tabs API extension).

Acceptance:
- At any moment, ≤ 1 `app.envato.com` tab AND ≤ 1 `elements.envato.com` tab.
- `download.data` requests visibly serial in the network panel.
- No 429 across the 5-item run.
- Wall-clock time per item is roughly licensing (~3s) + download (~5-30s) + jitter (~1-2s) — compare to baseline parallel mode wall-clock.

## Versioning + Rollout

- Extension version: `1.0.0 → 1.1.0` (minor bump — behavior change, no new permission).
- Stack on `feature/extension-fps-probe` (both touch queue.js; rebase cost of separate branches isn't worth the cleanliness gain).
- No new feature flag needed — this is a config tightening, not an opt-in. If the serialization causes user-visible slowness complaints, we can revisit with a flag later. Adding a flag preemptively is YAGNI.

## Out of Scope (deliberately deferred)

- **Combining resolve + license into one tab.** Today two tabs (different URLs). Refactoring to one tab would require the content script to perform both the UUID lookup and the license commit. Possible win in fewer tab opens, but adds risk. Out of scope for v1.
- **Per-source `envato_inter_item_delay_ms_override` config-fetch field.** Could expose the jitter range via `/api/ext-config` for remote tuning. YAGNI — defaults are reasonable; flag adds complexity for hypothetical tuning needs.
- **Adaptive backoff.** If we observe 429s even with serialization, dynamically increase the jitter delay. Not needed if serialization works; revisit if smoke #13 fails.

## Open Questions

- **Pause-then-resume semantics.** When the user pauses mid-Envato-cycle, we close the held license tab. On resume, item phase is reset where? If phase was `licensing` (URL not yet returned), re-license from scratch. If phase was `downloading` (URL returned but download paused by `chrome.downloads.pause()` if that ever fires here), let chrome.downloads resume naturally. The Ext.5 reconciliation code already handles `downloading` items via `chrome.downloads.search()`. Confirm this works for our case during implementation; if not, fix in the same PR.
- **Service worker restart while a license tab is held.** SW death almost certainly kills the tab too (hidden tabs don't survive). On cold start the item is in `licensing` phase but `license_tab_id` is gone (state was not persisted across SW death anyway — only run state is). Re-license. Behavior is correct by accident; document it as such.
