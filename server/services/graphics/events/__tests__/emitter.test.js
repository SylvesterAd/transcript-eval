import { describe, it, expect, vi } from 'vitest'

describe('pipeline event emitter', () => {
  it('subscribers receive emitted events for their session', async () => {
    const { emit, subscribe } = await import('../emitter.js')
    const events = []
    const unsubscribe = subscribe(7, (e) => events.push(e))
    emit({ sessionId: 7, step: 'render_queued', label: 'Queued' })
    emit({ sessionId: 7, step: 'frames_captured', label: 'Captured 4 frames' })
    emit({ sessionId: 8, step: 'foreign', label: 'should not arrive' })
    expect(events).toHaveLength(2)
    expect(events[0].step).toBe('render_queued')
    expect(events[1].step).toBe('frames_captured')
    unsubscribe()
    emit({ sessionId: 7, step: 'after_unsub', label: 'should not arrive' })
    expect(events).toHaveLength(2)
  })
})
