// Extension ID baked at build time by vite.config.js's `define` block
// from extension/.extension-id (committed by Ext.1) or the
// VITE_EXTENSION_ID env var.
//
// Why a separate file? So every consumer imports the same constant
// and there's one obvious place to look when "the extension isn't
// receiving messages." In dev, calling requireExtensionId() with an
// empty value throws with a copy-pasteable command to fix the env.

/* global __EXTENSION_ID__, __EXTENSION_ID_FALLBACKS__ */
export const EXT_ID = typeof __EXTENSION_ID__ === 'string' ? __EXTENSION_ID__ : ''

// Additional IDs the web app should probe if the primary EXT_ID isn't
// reachable. Populated by vite.config.js from the dev `key` in
// extension/manifest.json — covers the case where a user loaded the
// source folder unpacked (which gets the dev ID) instead of installing
// the Web Store build (which has a different ID). See commit f90edc6.
export const EXT_ID_FALLBACKS =
  typeof __EXTENSION_ID_FALLBACKS__ !== 'undefined' && Array.isArray(__EXTENSION_ID_FALLBACKS__)
    ? __EXTENSION_ID_FALLBACKS__
    : []

// Ordered list of IDs to probe: primary first, then fallbacks (deduped,
// nulls removed). useExtension.ping() walks this list and returns on
// the first match.
export function getExtIdsToProbe(primary = EXT_ID, fallbacks = EXT_ID_FALLBACKS) {
  const out = []
  const seen = new Set()
  for (const id of [primary, ...(fallbacks || [])]) {
    if (id && !seen.has(id)) {
      out.push(id)
      seen.add(id)
    }
  }
  return out
}

export const EXT_IDS_TO_PROBE = getExtIdsToProbe()

// Active extension ID — the one that responded to the most recent
// successful ping. Defaults to EXT_ID (the Web Store ID) so consumers
// that fire a chrome.runtime.sendMessage before any ping has run still
// hit something sensible. useExtension.ping() updates this when a
// fallback ID matches; downstream callers (useExportXmlKickoff for
// save_xml, useExportPort for openPort, etc.) MUST read this rather
// than EXT_ID directly so dev-loaded extensions keep working.
let _activeExtId = EXT_ID
export function getActiveExtId() { return _activeExtId }
export function setActiveExtId(id) {
  if (id && typeof id === 'string') _activeExtId = id
}

export function requireExtensionId() {
  if (!EXT_ID) {
    throw new Error(
      'EXT_ID is empty. Either commit extension/.extension-id (run ' +
      '`npm run ext:generate-key` from the extension worktree), or set ' +
      'VITE_EXTENSION_ID before starting vite (e.g. ' +
      '`VITE_EXTENSION_ID=abcdefghijklmnopqrstuvwxyzabcdef npm run dev:client`).'
    )
  }
  return EXT_ID
}
