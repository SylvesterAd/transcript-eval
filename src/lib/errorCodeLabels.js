// Task 1 fills this in — 15-code enum → human-string mapping for
// State F's failed-items list. Keep pure: no React, no extension
// imports, no side effects.
//
// See extension/modules/telemetry.js:185–201 for the enum source of
// truth. Copy those 15 values as a literal constant here — do NOT
// import from extension/ (web and extension are separate module
// graphs).

export const ERROR_CODE_LABELS = Object.freeze({})

export function getErrorLabel(_code) {
  return 'Unknown error'
}
