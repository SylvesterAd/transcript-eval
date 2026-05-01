// Regression test: an Envato 403/401 must NOT hardStop the whole queue.
//
// History (chronological):
//   1. Original — generic 403 → { hardStop }. Real-world export dump
//      showed 9 in-flight Pexels downloads cancelled mid-byte and 13
//      unrelated items mislabelled when the user's elements.session.5
//      cookie was missing.
//   2. First fix — generic 403 → { skip + skip_whole_source: 'envato' }.
//      Stopped killing Pexels but gave the user no way to recover.
//   3. Current — 401 AND 403 → { pauseForReauth }. queue.js pauses the
//      run, broadcasts envato_reauth_needed (web app shows a sign-in
//      banner), waits for cookie change OR 120s timeout, retries the
//      item once. Subsequent 401/403s in the same run skip with
//      skip_whole_source: 'envato' (queue handles the once-per-run gate).

import { describe, it, expect } from 'vitest'
import { classifyLicenseError } from '../classifier.js'

describe('classifyLicenseError — session-state failures', () => {
  it('401 returns pauseForReauth (not skip)', () => {
    const err = new Error('envato_session_missing')
    err.httpStatus = 401
    const verdict = classifyLicenseError(err, { license_attempts: 0 })
    expect(verdict.pauseForReauth).toBeDefined()
    expect(verdict.pauseForReauth.error_code).toBe('envato_session_401')
    expect(verdict.skip).toBeUndefined()
    expect(verdict.hardStop).toBeUndefined()
  })

  it('generic 403 returns pauseForReauth (not hardStop, not skip)', () => {
    const err = new Error('envato_403')
    err.httpStatus = 403
    err.body = ''
    const verdict = classifyLicenseError(err, { license_attempts: 0 })
    expect(verdict.pauseForReauth).toBeDefined()
    expect(verdict.pauseForReauth.error_code).toBe('envato_403')
    expect(verdict.skip).toBeUndefined()
    expect(verdict.hardStop).toBeUndefined()
  })

  it('403 with "upgrade" in body still routes to envato_402_tier (tier-restricted item, not session)', () => {
    const err = new Error('envato_403')
    err.httpStatus = 403
    err.body = 'Please upgrade your subscription to access this item.'
    const verdict = classifyLicenseError(err, { license_attempts: 0 })
    expect(verdict.skip).toBeDefined()
    expect(verdict.skip.error_code).toBe('envato_402_tier')
    expect(verdict.skip.skip_whole_source).toBeUndefined()
    expect(verdict.pauseForReauth).toBeUndefined()
  })

  it('402 still skips item-only with envato_402_tier (tier-restricted, not session)', () => {
    const err = new Error('envato_402')
    err.httpStatus = 402
    const verdict = classifyLicenseError(err, { license_attempts: 0 })
    expect(verdict.skip).toBeDefined()
    expect(verdict.skip.error_code).toBe('envato_402_tier')
    expect(verdict.pauseForReauth).toBeUndefined()
  })
})
