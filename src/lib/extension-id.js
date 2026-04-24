// Extension ID baked at build time by vite.config.js's `define` block
// from extension/.extension-id (committed by Ext.1) or the
// VITE_EXTENSION_ID env var.
//
// Why a separate file? So every consumer imports the same constant
// and there's one obvious place to look when "the extension isn't
// receiving messages." In dev, calling requireExtensionId() with an
// empty value throws with a copy-pasteable command to fix the env.

/* global __EXTENSION_ID__ */
export const EXT_ID = typeof __EXTENSION_ID__ === 'string' ? __EXTENSION_ID__ : ''

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
