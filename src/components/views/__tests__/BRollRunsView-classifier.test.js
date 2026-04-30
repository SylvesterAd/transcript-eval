// Unit tests for the b-roll pipeline status classifier exported from
// BRollRunsView. The admin UI used to mark every pipeline whose DB stages
// hadn't reached `expectedStages` as 'interrupted' the moment it wasn't in
// the in-memory `brollPipelineProgress` map. That fired during long LLM
// stages (when no broll_runs row had been written for several minutes) and
// during the brief gap right after a server restart, before resume re-fired
// the pipelines — both scenarios where the work was actually progressing.
//
// classifyPipelineStatus distinguishes "incomplete + recent activity"
// (running) from "incomplete + stale" (interrupted) using the latest
// broll_runs.created_at recorded as p.createdAt.

import { describe, it, expect } from 'vitest'
import { classifyPipelineStatus } from '../BRollRunsView.jsx'

const NOW = 1_700_000_000_000  // fixed reference timestamp (ms)
const minutesAgo = (m) => new Date(NOW - m * 60 * 1000).toISOString()

describe('classifyPipelineStatus', () => {
  it('returns complete when all main stages are on disk', () => {
    expect(classifyPipelineStatus({
      status: 'complete', expectedStages: 7, stages: new Array(7),
      createdAt: minutesAgo(0),
    }, { now: NOW })).toBe('complete')
  })

  it('returns failed when any DB row failed (preserved regardless of stages)', () => {
    expect(classifyPipelineStatus({
      status: 'failed', expectedStages: 7, stages: new Array(3),
      createdAt: minutesAgo(0),
    }, { now: NOW })).toBe('failed')
  })

  it('returns running when stages incomplete but last row is recent', () => {
    expect(classifyPipelineStatus({
      status: 'complete', expectedStages: 7, stages: new Array(3),
      createdAt: minutesAgo(1),
    }, { now: NOW })).toBe('running')
  })

  it('returns running at the boundary just below the recent-activity TTL', () => {
    // 4m59s ago — under the 5m default
    expect(classifyPipelineStatus({
      status: 'complete', expectedStages: 7, stages: new Array(2),
      createdAt: new Date(NOW - (4 * 60 + 59) * 1000).toISOString(),
    }, { now: NOW })).toBe('running')
  })

  it('returns interrupted when stages incomplete and last row is stale (>TTL)', () => {
    expect(classifyPipelineStatus({
      status: 'complete', expectedStages: 7, stages: new Array(3),
      createdAt: minutesAgo(30),
    }, { now: NOW })).toBe('interrupted')
  })

  it('returns interrupted when createdAt is missing entirely', () => {
    expect(classifyPipelineStatus({
      status: 'complete', expectedStages: 7, stages: new Array(3),
    }, { now: NOW })).toBe('interrupted')
  })

  it('does not reclassify when expectedStages is unknown (legacy rows)', () => {
    expect(classifyPipelineStatus({
      status: 'complete', stages: new Array(3),
      createdAt: minutesAgo(30),
    }, { now: NOW })).toBe('complete')
  })
})
