import { describe, it, expect } from 'vitest'
import { aggregateChainStatus, aggregateProgress } from '../ProjectsView.jsx'

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

describe('aggregateProgress', () => {
  // Regression: the home page used to show "Processing 5/6" forever for
  // completed full-auto-split projects because parent.assembly_status sticks
  // at 'confirmed' (sync 'done' lives on the sub-group). The /videos query's
  // COALESCE on rough_cut_status / broll_chain_status falls back to the
  // sub-group's value when parent's is null, so we infer sync-done from
  // those instead of relying on parent.assembly_status.
  it('counts split full-auto chain as 6/6 + terminal once broll is done', () => {
    const p = {
      transcriptionStatus: 'done',
      assembly_status: 'confirmed',  // parent sticks here
      rough_cut_status: 'done',      // from sub via COALESCE
      broll_chain_status: 'done',    // from sub via COALESCE
      auto_rough_cut: true,
      path_id: 'guided',
    }
    expect(aggregateProgress(p)).toEqual({ done: 6, total: 6, terminal: true })
  })

  it('marks sync done as soon as rough cut starts on the sub-group', () => {
    const p = {
      transcriptionStatus: 'done',
      assembly_status: 'confirmed',
      rough_cut_status: 'running',
      broll_chain_status: null,
      auto_rough_cut: true,
      path_id: 'hands-off',
    }
    // upload, transcribe, classify, sync = 4 done; rough_cut + broll pending
    expect(aggregateProgress(p)).toEqual({ done: 4, total: 6, terminal: false })
  })

  it('keeps sync pending while sync itself is running on the sub-group', () => {
    const p = {
      transcriptionStatus: 'done',
      assembly_status: 'confirmed',
      rough_cut_status: null,
      broll_chain_status: null,
      auto_rough_cut: true,
      path_id: 'hands-off',
    }
    // upload, transcribe, classify = 3 done; sync still running
    expect(aggregateProgress(p)).toEqual({ done: 3, total: 6, terminal: false })
  })

  it('still works for legacy single-group case where parent reaches done', () => {
    const p = {
      transcriptionStatus: 'done',
      assembly_status: 'done',  // single-group: parent IS the synced group
      rough_cut_status: 'done',
      broll_chain_status: null,
      auto_rough_cut: true,
      path_id: null,
    }
    // upload, transcribe, classify, sync, rough_cut = 5; broll skipped (no path_id)
    // terminal: syncDone && !path_id → true
    expect(aggregateProgress(p)).toEqual({ done: 5, total: 6, terminal: true })
  })

  it('marks guided full-auto-split terminal once it pauses for review (no broll done yet)', () => {
    const p = {
      transcriptionStatus: 'done',
      assembly_status: 'confirmed',
      rough_cut_status: 'done',
      broll_chain_status: 'paused_at_rough_cut',  // guided pauses here for human review
      auto_rough_cut: true,
      path_id: 'guided',
    }
    // upload, transcribe, classify, sync, rough_cut = 5; broll not done yet
    // terminal: syncDone && path_id === 'guided' → true (waiting on user, not on machine)
    expect(aggregateProgress(p)).toEqual({ done: 5, total: 6, terminal: true })
  })

  it('keeps hands-off full-auto-split active until the broll chain finishes', () => {
    const p = {
      transcriptionStatus: 'done',
      assembly_status: 'confirmed',
      rough_cut_status: 'done',
      broll_chain_status: 'running',
      auto_rough_cut: true,
      path_id: 'hands-off',
    }
    // upload, transcribe, classify, sync, rough_cut = 5; broll still running
    // terminal: hands-off requires broll_chain_status === 'done' → false
    expect(aggregateProgress(p)).toEqual({ done: 5, total: 6, terminal: false })
  })
})
