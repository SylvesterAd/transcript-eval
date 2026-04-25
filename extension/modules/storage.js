// Single owner of all chrome.storage.local access the queue touches.
//
// Keys (enumerated so a future reader can audit what the extension
// persists):
//
//   run:<runId>
//     Full RunState JSON for an active or completed run. See queue.js
//     for the RunState shape. Written on every phase transition;
//     deleted on cancel; retained on complete (so a returning user
//     sees the last run in the popup until a new run starts or they
//     manually clear).
//
//   active_run_id
//     string | null. The single-active-run lock. Set on startRun,
//     cleared on complete / cancel. A second startRun while this is
//     set fails with {ok:false, reason:'run_already_active'}.
//
//   completed_items
//     { "<user_id>|<source>|<source_item_id>|<target_folder>": true, ... }
//     Flat object used as a set — key membership means "this item was
//     downloaded successfully to this folder by this user". Ext.5
//     writes on item success; the export page's pre-flight reads this
//     to compute "already on disk" counts. (Full dedup policy lives
//     in the web app; the extension just records.)
//
//   deny_list
//     { "<source>|<source_item_id>": { reason, first_seen_at } }
//     Items the extension refuses to download on future runs (e.g.
//     unsupported_filetype ZIPs). Ext.7 writes; Ext.5 just reads at
//     JIT-license time and respects.
//
//   daily_counts
//     { "<YYYY-MM-DD>": { envato, pexels, freepik } }
//     Per-source per-day download counters for the fair-use cap.
//     Ext.7 increments + enforces; Ext.5 only reads (and may soft-warn
//     but not hard-stop; hard-stop is Ext.7's feature).
//
//   deny_list_alerted
//     { "<source>|<source_item_id>|<error_code>": <last_emitted_at_epoch_ms> }
//     Dedupe map for 24h-rate-limited telemetry alerts. Ext.7 reads
//     before emitting an alert-flagged event; writes on emit. MV3 SW
//     termination would otherwise lose this — persistence is mandatory.
//
// MV3 single-SW-instance note: Chrome runs exactly one service worker
// per extension at a time. `active_run_id` CAS via a read-then-write
// is therefore safe against extension-side races. Races against the
// user clicking Start in two tabs simultaneously resolve through Port
// ordering — whichever tab's message lands at onMessageExternal first
// wins the CAS.

import { DENY_LIST_ALERT_DEDUPE_MS, DAILY_CAP_WARN_AT, DAILY_CAP_HARD_STOP_AT } from '../config.js'

const K = {
  runPrefix: 'run:',
  activeRunId: 'active_run_id',
  completedItems: 'completed_items',
  denyList: 'deny_list',
  dailyCounts: 'daily_counts',
  denyListAlerted: 'deny_list_alerted',
}

function runKey(runId) {
  return K.runPrefix + runId
}

// -------------------- RunState --------------------

export async function saveRunState(runId, state) {
  if (!runId || typeof runId !== 'string') {
    throw new Error('saveRunState: runId must be a non-empty string')
  }
  if (!state || typeof state !== 'object') {
    throw new Error('saveRunState: state must be an object')
  }
  const withStamp = { ...state, updated_at: Date.now() }
  await chrome.storage.local.set({ [runKey(runId)]: withStamp })
}

export async function loadRunState(runId) {
  const key = runKey(runId)
  const { [key]: state } = await chrome.storage.local.get(key)
  return state || null
}

export async function deleteRunState(runId) {
  await chrome.storage.local.remove(runKey(runId))
}

// -------------------- active_run_id lock --------------------

export async function getActiveRunId() {
  const { [K.activeRunId]: v } = await chrome.storage.local.get(K.activeRunId)
  return v || null
}

// Atomic-enough CAS. Reads active_run_id; if null or equal to the
// requested runId, sets it and returns {ok:true}. Otherwise returns
// {ok:false, activeRunId}. The MV3 single-SW-instance property makes
// this read-then-write safe from races with our own workers.
export async function setActiveRunId(runId) {
  if (!runId || typeof runId !== 'string') {
    throw new Error('setActiveRunId: runId must be a non-empty string')
  }
  const current = await getActiveRunId()
  if (current && current !== runId) {
    return { ok: false, activeRunId: current }
  }
  await chrome.storage.local.set({ [K.activeRunId]: runId })
  return { ok: true }
}

export async function clearActiveRunId() {
  await chrome.storage.local.remove(K.activeRunId)
}

// -------------------- completed_items --------------------

function completedKey(userId, source, itemId, folder) {
  return `${userId}|${source}|${itemId}|${folder}`
}

export async function isCompleted(userId, source, itemId, folder) {
  const { [K.completedItems]: map } = await chrome.storage.local.get(K.completedItems)
  return !!(map && map[completedKey(userId, source, itemId, folder)])
}

export async function markCompleted(userId, source, itemId, folder) {
  const { [K.completedItems]: existing } = await chrome.storage.local.get(K.completedItems)
  const map = existing || {}
  map[completedKey(userId, source, itemId, folder)] = { t: Date.now() }
  await chrome.storage.local.set({ [K.completedItems]: map })
}

// Returns the set of { source, source_item_id } that this user has
// previously completed in this folder — used by the export page's
// pre-flight "already on disk" accounting. Cost is O(n) over the
// completed_items object; acceptable for <100k items per user.
export async function getAllCompletedForFolder(userId, folder) {
  const { [K.completedItems]: map } = await chrome.storage.local.get(K.completedItems)
  if (!map) return []
  const prefix = `${userId}|`
  const suffix = `|${folder}`
  const out = []
  for (const k of Object.keys(map)) {
    if (!k.startsWith(prefix) || !k.endsWith(suffix)) continue
    const parts = k.split('|')
    // [userId, source, source_item_id, ...folder-may-contain-pipes]
    if (parts.length < 4) continue
    out.push({ source: parts[1], source_item_id: parts[2] })
  }
  return out
}

// -------------------- deny_list (read-only in Ext.5) --------------------

export async function isDenied(source, sourceItemId) {
  const { [K.denyList]: map } = await chrome.storage.local.get(K.denyList)
  return !!(map && map[`${source}|${sourceItemId}`])
}

// Writer is Ext.7's territory but the signature is stubbed here so
// Ext.7 can land a single-file change.
export async function addToDenyList(source, sourceItemId, reason) {
  const { [K.denyList]: existing } = await chrome.storage.local.get(K.denyList)
  const map = existing || {}
  map[`${source}|${sourceItemId}`] = { reason, first_seen_at: Date.now() }
  await chrome.storage.local.set({ [K.denyList]: map })
}

// -------------------- daily_counts (read-only in Ext.5) --------------------

function today() {
  const d = new Date()
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export async function getDailyCount(source) {
  const { [K.dailyCounts]: map } = await chrome.storage.local.get(K.dailyCounts)
  const day = map && map[today()]
  return (day && day[source]) || 0
}

// Writer is Ext.7's territory.
export async function incrementDailyCount(source) {
  const { [K.dailyCounts]: existing } = await chrome.storage.local.get(K.dailyCounts)
  const map = existing || {}
  const d = today()
  map[d] = map[d] || { envato: 0, pexels: 0, freepik: 0 }
  map[d][source] = (map[d][source] || 0) + 1
  await chrome.storage.local.set({ [K.dailyCounts]: map })
}

// -------------------- deny_list_alerted (Ext.7) --------------------

function denyAlertKey(source, itemId, errorCode) {
  return `${source}|${itemId}|${errorCode}`
}

// Ext.7. Returns true if we should emit a Slack-alert-flagged telemetry
// event for this (source, item, error_code) tuple now — i.e. the 24h
// dedupe window has elapsed. Returns false if we alerted recently.
export async function shouldAlertForDeny(source, itemId, errorCode) {
  const { [K.denyListAlerted]: map } = await chrome.storage.local.get(K.denyListAlerted)
  const last = map && map[denyAlertKey(source, itemId, errorCode)]
  if (!last) return true
  return Date.now() - last >= DENY_LIST_ALERT_DEDUPE_MS
}

// Ext.7. Stamps the dedupe map with `now` for this (source, item,
// error_code). Call BEFORE emitting the alert (so a SW death between
// the persist and emit doesn't duplicate-alert on next SW wake).
export async function markAlertEmitted(source, itemId, errorCode) {
  const { [K.denyListAlerted]: existing } = await chrome.storage.local.get(K.denyListAlerted)
  const map = existing || {}
  map[denyAlertKey(source, itemId, errorCode)] = Date.now()
  await chrome.storage.local.set({ [K.denyListAlerted]: map })
}

// Ext.7. Returns 'ok' / 'warn' / 'hard_stop' based on the current
// day's count for `source`. Called by the queue before every download
// start AND after every download complete (the cap is on completed
// downloads; `warn` fires on the download that would cross the warn
// threshold, `hard_stop` fires when we try to start a download at or
// above the hard-stop threshold).
export async function checkDailyCapThreshold(source) {
  const count = await getDailyCount(source)
  if (count >= DAILY_CAP_HARD_STOP_AT) return 'hard_stop'
  if (count >= DAILY_CAP_WARN_AT) return 'warn'
  return 'ok'
}
