import { describe, it, expect } from 'vitest'
import { deriveMode, deriveStages } from '../ProcessingModal.jsx'

describe('deriveMode', () => {
  it('returns uploading when any file is still uploading', () => {
    const state = { parent: { videos: [{ transcription_status: null, file_path: null, cf_stream_uid: null }] }, files: [{ status: 'uploading' }] }
    expect(deriveMode(state)).toBe('uploading')
  })
  it('returns pipeline when uploads done but pipeline not terminal', () => {
    const state = { parent: { videos: [{ transcription_status: 'transcribing', cf_stream_uid: 'x' }] }, files: [{ status: 'complete' }] }
    expect(deriveMode(state)).toBe('pipeline')
  })
  it('returns done when all stages terminal', () => {
    const state = { parent: { videos: [{ transcription_status: 'done', cf_stream_uid: 'x' }], assembly_status: 'confirmed', auto_rough_cut: true }, subGroups: [{ assembly_status: 'done', rough_cut_status: 'done', broll_chain_status: 'done' }], files: [{ status: 'complete' }] }
    expect(deriveMode(state)).toBe('done')
  })
})

describe('deriveStages', () => {
  it('marks transcribe stage active when at least one transcription is in flight', () => {
    const state = { parent: { videos: [{ transcription_status: 'transcribing', cf_stream_uid: 'x' }] } }
    const stages = deriveStages(state)
    const t = stages.find(s => s.id === 'transcribe')
    expect(t.active).toBe(true)
  })
  it('marks rough_cut as skipped when auto_rough_cut is false', () => {
    const state = { parent: { auto_rough_cut: false, videos: [] }, subGroups: [{ rough_cut_status: null }] }
    const stages = deriveStages(state)
    const r = stages.find(s => s.id === 'rough_cut')
    expect(r.skipped).toBe(true)
  })
  it('marks paused_at_strategy when broll_chain_status is paused', () => {
    const state = { parent: { auto_rough_cut: false, videos: [] }, subGroups: [{ broll_chain_status: 'paused_at_strategy' }] }
    const stages = deriveStages(state)
    const s = stages.find(s => s.id === 'broll_strategy')
    expect(s.paused).toBe(true)
  })
})
