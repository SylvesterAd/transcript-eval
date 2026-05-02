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

  it('returns true for guided + failed at refs/strategy/plan', () => {
    expect(shouldRedirectFailedPrePause({
      path_id: 'guided',
      broll_chain_status: 'failed',
      broll_chain_substage: 'plan',
    })).toBe(true)
  })

  it('returns false for guided + failed at search (post-pause)', () => {
    expect(shouldRedirectFailedPrePause({
      path_id: 'guided',
      broll_chain_status: 'failed',
      broll_chain_substage: 'search',
    })).toBe(false)
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
