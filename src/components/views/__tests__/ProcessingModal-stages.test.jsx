import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { deriveMode, deriveStages, FailedView } from '../ProcessingModal.jsx'

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

  it('returns "failed" when hands-off sub-group is failed at any substage', () => {
    const state = {
      parent: { videos: [{ transcription_status: 'done', cf_stream_uid: 'x' }], assembly_status: 'confirmed', path_id: 'hands-off', auto_rough_cut: false },
      subGroups: [{ assembly_status: 'done', rough_cut_status: null, broll_chain_status: 'failed', broll_chain_substage: 'refs', path_id: 'hands-off' }],
      files: [{ status: 'complete' }],
    }
    expect(deriveMode(state)).toBe('failed')
  })

  it('returns "failed" when strategy-only sub-group is failed at strategy substage', () => {
    const state = {
      parent: { videos: [{ transcription_status: 'done', cf_stream_uid: 'x' }], assembly_status: 'confirmed', path_id: 'strategy-only', auto_rough_cut: false },
      subGroups: [{ assembly_status: 'done', rough_cut_status: null, broll_chain_status: 'failed', broll_chain_substage: 'strategy', path_id: 'strategy-only' }],
      files: [{ status: 'complete' }],
    }
    expect(deriveMode(state)).toBe('failed')
  })

  it('returns "done" (not "failed") when strategy-only sub-group failed at search (post-pause)', () => {
    const state = {
      parent: { videos: [{ transcription_status: 'done', cf_stream_uid: 'x' }], assembly_status: 'confirmed', path_id: 'strategy-only', auto_rough_cut: false },
      subGroups: [{ assembly_status: 'done', rough_cut_status: null, broll_chain_status: 'failed', broll_chain_substage: 'search', path_id: 'strategy-only' }],
      files: [{ status: 'complete' }],
    }
    expect(deriveMode(state)).toBe('done')
  })

  it('returns "done" when all sub-groups are truly done', () => {
    const state = {
      parent: { videos: [{ transcription_status: 'done', cf_stream_uid: 'x' }], assembly_status: 'confirmed', path_id: 'hands-off', auto_rough_cut: false },
      subGroups: [{ assembly_status: 'done', rough_cut_status: null, broll_chain_status: 'done', path_id: 'hands-off' }],
      files: [{ status: 'complete' }],
    }
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
  it('marks classify as paused when assembly_status is classified and no sub-groups exist', () => {
    const state = { parent: { assembly_status: 'classified', videos: [{ transcription_status: 'done', cf_stream_uid: 'x' }] }, subGroups: [] }
    const stages = deriveStages(state)
    const c = stages.find(s => s.id === 'classify')
    expect(c.paused).toBe(true)
    expect(c.done).toBe(false)
    expect(c.active).toBe(false)
  })
  it('does not mark classify as paused once sub-groups exist', () => {
    const state = { parent: { assembly_status: 'classified', videos: [] }, subGroups: [{ id: 1 }] }
    const stages = deriveStages(state)
    const c = stages.find(s => s.id === 'classify')
    expect(c.paused).toBe(false)
    expect(c.done).toBe(true)
  })
})

describe('<FailedView />', () => {
  // RTL doesn't auto-cleanup without @testing-library/jest-dom or vitest's
  // globals enabled, so we unmount manually between tests to keep
  // screen.* queries scoped to the latest render.
  afterEach(() => cleanup())

  function renderWithRouter(ui) {
    return render(<MemoryRouter>{ui}</MemoryRouter>)
  }

  it('renders headline and contact-support CTA', () => {
    renderWithRouter(
      <FailedView subGroups={[{ id: 9, broll_chain_substage: 'refs' }]} />,
    )
    // getByText/getByRole throw when nothing matches, so a truthy check
    // is sufficient — matches the intent of toBeInTheDocument without
    // requiring @testing-library/jest-dom (not installed).
    expect(screen.getByText(/something went wrong/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /contact support/i })).toBeTruthy()
  })

  it('mentions the substage where the chain broke', () => {
    renderWithRouter(
      <FailedView subGroups={[{ id: 9, broll_chain_substage: 'strategy' }]} />,
    )
    expect(screen.getByText(/strategy/i)).toBeTruthy()
  })

  it('renders an escape-hatch link to the editor', () => {
    renderWithRouter(
      <FailedView subGroups={[{ id: 9, broll_chain_substage: 'refs' }]} />,
    )
    const link = screen.getByRole('link', { name: /continue to editor/i })
    expect(link.getAttribute('href')).toBe('/editor/9/assets')
  })
})
