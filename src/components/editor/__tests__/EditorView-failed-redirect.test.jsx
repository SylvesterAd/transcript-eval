import { describe, it, expect } from 'vitest'
import { shouldRedirectFailedPrePause } from '../EditorView.jsx'

describe('shouldRedirectFailedPrePause', () => {
  it('returns true for hands-off + failed at any substage', () => {
    expect(shouldRedirectFailedPrePause({
      path_id: 'hands-off',
      broll_chain_status: 'failed',
      broll_chain_substage: 'refs',
    })).toBe(true)
    expect(shouldRedirectFailedPrePause({
      path_id: 'hands-off',
      broll_chain_status: 'failed',
      broll_chain_substage: 'search',
    })).toBe(true)
  })

  it('returns true for strategy-only + failed at refs/strategy', () => {
    expect(shouldRedirectFailedPrePause({
      path_id: 'strategy-only',
      broll_chain_status: 'failed',
      broll_chain_substage: 'strategy',
    })).toBe(true)
    expect(shouldRedirectFailedPrePause({
      path_id: 'strategy-only',
      broll_chain_status: 'failed',
      broll_chain_substage: 'refs',
    })).toBe(true)
  })

  it('returns false for strategy-only + failed at plan/search (post-pause → editor)', () => {
    expect(shouldRedirectFailedPrePause({
      path_id: 'strategy-only',
      broll_chain_status: 'failed',
      broll_chain_substage: 'plan',
    })).toBe(false)
    expect(shouldRedirectFailedPrePause({
      path_id: 'strategy-only',
      broll_chain_status: 'failed',
      broll_chain_substage: 'search',
    })).toBe(false)
  })

  // After commit 49ec14c, guided's pre-pause boundary moved to
  // 'rough_cut' (earliest auto-chain stage). Anything failing AFTER
  // rough_cut means the user already saw the rough-cut hand-off point
  // and is being routed into the editor; the failure shows as a banner
  // there, not via redirect to <FailedView>.
  it('returns true for guided + failed at rough_cut (pre-pause boundary)', () => {
    expect(shouldRedirectFailedPrePause({
      path_id: 'guided',
      broll_chain_status: 'failed',
      broll_chain_substage: 'rough_cut',
    })).toBe(true)
  })

  it('returns false for guided + failed at refs/strategy/plan/search (post-pause)', () => {
    for (const substage of ['refs', 'strategy', 'plan', 'search']) {
      expect(shouldRedirectFailedPrePause({
        path_id: 'guided',
        broll_chain_status: 'failed',
        broll_chain_substage: substage,
      })).toBe(false)
    }
  })

  it('returns false for null path (manual mode — no auto-chain expected)', () => {
    expect(shouldRedirectFailedPrePause({
      path_id: null,
      broll_chain_status: 'failed',
      broll_chain_substage: 'refs',
    })).toBe(false)
  })

  it('returns false for non-failed status', () => {
    expect(shouldRedirectFailedPrePause({
      path_id: 'hands-off',
      broll_chain_status: 'done',
    })).toBe(false)
    expect(shouldRedirectFailedPrePause({
      path_id: 'hands-off',
      broll_chain_status: 'running',
    })).toBe(false)
    expect(shouldRedirectFailedPrePause({
      path_id: 'hands-off',
      broll_chain_status: null,
    })).toBe(false)
  })

  it('returns false when group is null/undefined (loading state)', () => {
    expect(shouldRedirectFailedPrePause(null)).toBe(false)
    expect(shouldRedirectFailedPrePause(undefined)).toBe(false)
    expect(shouldRedirectFailedPrePause({})).toBe(false)
  })
})
