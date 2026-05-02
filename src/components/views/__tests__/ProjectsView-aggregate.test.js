import { describe, it, expect } from 'vitest'
import { aggregateChainStatus } from '../ProjectsView.jsx'

describe('aggregateChainStatus', () => {
  it('returns null when there are no sub-groups', () => {
    expect(aggregateChainStatus([])).toEqual({ status: null, substage: null })
  })

  it('returns running with substage when any sub-group is running', () => {
    expect(aggregateChainStatus([
      { broll_chain_status: 'done' },
      { broll_chain_status: 'running', broll_chain_substage: 'plan' },
    ])).toEqual({ status: 'running', substage: 'plan' })
  })

  it('returns failed with substage when any sub-group is failed (and none running)', () => {
    expect(aggregateChainStatus([
      { broll_chain_status: 'done' },
      { broll_chain_status: 'failed', broll_chain_substage: 'refs' },
    ])).toEqual({ status: 'failed', substage: 'refs' })
  })

  it('running outranks failed', () => {
    expect(aggregateChainStatus([
      { broll_chain_status: 'failed', broll_chain_substage: 'refs' },
      { broll_chain_status: 'running', broll_chain_substage: 'strategy' },
    ])).toEqual({ status: 'running', substage: 'strategy' })
  })

  it('returns paused_at_strategy when present and no running/failed', () => {
    expect(aggregateChainStatus([
      { broll_chain_status: 'done' },
      { broll_chain_status: 'paused_at_strategy' },
    ])).toEqual({ status: 'paused_at_strategy', substage: 'strategy' })
  })

  it('returns done when every sub-group is done', () => {
    expect(aggregateChainStatus([
      { broll_chain_status: 'done' },
      { broll_chain_status: 'done' },
    ])).toEqual({ status: 'done', substage: null })
  })
})
