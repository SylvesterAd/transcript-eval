// Unit tests for errorCodeLabels. Runs under the `web` vitest project
// (happy-dom env) — but this module is pure, so it doesn't touch any
// DOM globals. Still, keep it .js not .jsx — no JSX here.

import { describe, it, expect } from 'vitest'
import { ERROR_CODE_LABELS, getErrorLabel } from '../errorCodeLabels.js'

// The 15 codes from extension/modules/telemetry.js:185–201. If the
// extension enum grows, this list must grow in lockstep — that's the
// invariant exhaustiveness is asserting.
const EXPECTED_CODES = [
  'envato_403',
  'envato_402_tier',
  'envato_429',
  'envato_session_401',
  'envato_unavailable',
  'envato_unsupported_filetype',
  'freepik_404',
  'freepik_429',
  'freepik_unconfigured',
  'pexels_404',
  'network_failed',
  'disk_failed',
  'integrity_failed',
  'resolve_failed',
  'url_expired_refetch_failed',
]

describe('ERROR_CODE_LABELS', () => {
  it('has exactly the 15 expected codes', () => {
    const keys = Object.keys(ERROR_CODE_LABELS).sort()
    expect(keys).toEqual([...EXPECTED_CODES].sort())
    expect(keys).toHaveLength(15)
  })

  it('every label is a non-empty string', () => {
    for (const code of EXPECTED_CODES) {
      expect(typeof ERROR_CODE_LABELS[code]).toBe('string')
      expect(ERROR_CODE_LABELS[code].length).toBeGreaterThan(0)
    }
  })

  it('is frozen (cannot be mutated at runtime)', () => {
    expect(Object.isFrozen(ERROR_CODE_LABELS)).toBe(true)
  })
})

describe('getErrorLabel', () => {
  it('returns the label for a known code', () => {
    expect(getErrorLabel('envato_session_401')).toBe(ERROR_CODE_LABELS.envato_session_401)
    expect(getErrorLabel('disk_failed')).toBe(ERROR_CODE_LABELS.disk_failed)
  })

  it('returns a readable fallback for null', () => {
    expect(getErrorLabel(null)).toMatch(/unknown/i)
  })

  it('returns a readable fallback for undefined', () => {
    expect(getErrorLabel(undefined)).toMatch(/unknown/i)
  })

  it('returns a fallback that includes the raw code for unknown strings', () => {
    const label = getErrorLabel('some_future_code_we_dont_know')
    expect(label).toMatch(/unknown/i)
    expect(label).toContain('some_future_code_we_dont_know')
  })

  it('is pure — same input yields same output', () => {
    expect(getErrorLabel('pexels_404')).toBe(getErrorLabel('pexels_404'))
  })
})
