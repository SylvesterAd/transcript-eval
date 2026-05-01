// Reducer behavior for the mid-run Envato re-auth flow.
//
// Extension broadcasts {type:'envato_reauth_needed'} when the queue
// pauses on a 401/403 (stale elements.session.5 cookie). useExportPort
// dispatches message_envato_reauth_needed → reducer sets envatoReauth,
// State D renders the sign-in banner. When the queue resumes (run_state
// flips back to 'running'), the next state snapshot clears envatoReauth.

import { describe, it, expect } from 'vitest'
import { progressReducer, INITIAL_PROGRESS_STATE } from '../progressState.js'

describe('progressReducer — Envato re-auth banner', () => {
  it('starts with envatoReauth=null', () => {
    expect(INITIAL_PROGRESS_STATE.envatoReauth).toBe(null)
  })

  it('message_envato_reauth_needed sets envatoReauth from the payload', () => {
    const next = progressReducer(INITIAL_PROGRESS_STATE, {
      type: 'message_envato_reauth_needed',
      payload: {
        signInUrl: 'https://elements.envato.com/sign-in',
        errorCode: 'envato_403',
        maxWaitMs: 120000,
      },
    })
    expect(next.envatoReauth).toMatchObject({
      signInUrl: 'https://elements.envato.com/sign-in',
      errorCode: 'envato_403',
      maxWaitMs: 120000,
    })
    expect(typeof next.envatoReauth.since).toBe('number')
  })

  it('falls back to defaults when the payload is sparse', () => {
    const next = progressReducer(INITIAL_PROGRESS_STATE, {
      type: 'message_envato_reauth_needed',
      payload: {},
    })
    expect(next.envatoReauth.signInUrl).toBe('https://elements.envato.com/sign-in')
    expect(next.envatoReauth.errorCode).toBe('envato_403')
    expect(next.envatoReauth.maxWaitMs).toBe(120000)
  })

  it('keeps envatoReauth across a paused-state snapshot (queue still paused)', () => {
    const withReauth = progressReducer(INITIAL_PROGRESS_STATE, {
      type: 'message_envato_reauth_needed',
      payload: {},
    })
    const next = progressReducer(withReauth, {
      type: 'message_state',
      payload: { runId: 'r1', run_state: 'paused', items: [], stats: {} },
    })
    expect(next.envatoReauth).not.toBe(null)
    expect(next.envatoReauth.errorCode).toBe('envato_403')
  })

  it('clears envatoReauth when the run resumes (run_state=running)', () => {
    const withReauth = progressReducer(INITIAL_PROGRESS_STATE, {
      type: 'message_envato_reauth_needed',
      payload: {},
    })
    const next = progressReducer(withReauth, {
      type: 'message_state',
      payload: { runId: 'r1', run_state: 'running', items: [], stats: {} },
    })
    expect(next.envatoReauth).toBe(null)
  })

  it('clears envatoReauth when the run completes (run_state=complete)', () => {
    const withReauth = progressReducer(INITIAL_PROGRESS_STATE, {
      type: 'message_envato_reauth_needed',
      payload: {},
    })
    const next = progressReducer(withReauth, {
      type: 'message_state',
      payload: { runId: 'r1', run_state: 'complete', items: [], stats: {} },
    })
    expect(next.envatoReauth).toBe(null)
  })
})
