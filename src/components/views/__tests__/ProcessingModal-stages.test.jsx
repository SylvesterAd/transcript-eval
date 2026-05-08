import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { deriveMode, deriveStages, shouldShowReviewRoughCutBanner, FailedView } from '../ProcessingModal.jsx'

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

  // Regression: paused_at_* used to count as terminal, flipping the modal
  // into <DoneView> the moment the chain paused for review. The "Open
  // project" button there hard-codes /sync, herding the user past the
  // review point — and the editor's auto-resume effect then advances the
  // chain on first click.
  it('returns "pipeline" (not "done") when sub-group is paused_at_rough_cut for guided review', () => {
    const state = {
      parent: { videos: [{ transcription_status: 'done', cf_stream_uid: 'x' }], assembly_status: 'confirmed', path_id: 'guided', auto_rough_cut: true },
      subGroups: [{ assembly_status: 'done', rough_cut_status: 'done', broll_chain_status: 'paused_at_rough_cut', path_id: 'guided' }],
      files: [{ status: 'complete' }],
    }
    expect(deriveMode(state)).toBe('pipeline')
  })

  it('returns "pipeline" when sub-group is paused_at_strategy', () => {
    const state = {
      parent: { videos: [{ transcription_status: 'done', cf_stream_uid: 'x' }], assembly_status: 'confirmed', path_id: 'strategy-only', auto_rough_cut: false },
      subGroups: [{ assembly_status: 'done', rough_cut_status: null, broll_chain_status: 'paused_at_strategy', path_id: 'strategy-only' }],
      files: [{ status: 'complete' }],
    }
    expect(deriveMode(state)).toBe('pipeline')
  })

  it('returns "pipeline" when sub-group is paused_at_plan', () => {
    const state = {
      parent: { videos: [{ transcription_status: 'done', cf_stream_uid: 'x' }], assembly_status: 'confirmed', path_id: 'guided', auto_rough_cut: true },
      subGroups: [{ assembly_status: 'done', rough_cut_status: 'done', broll_chain_status: 'paused_at_plan', path_id: 'guided' }],
      files: [{ status: 'complete' }],
    }
    expect(deriveMode(state)).toBe('pipeline')
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

  // Regression: paused_at_strategy used to leave "References analyzed"
  // stuck on Pending — `done` was only true when chain was actively
  // running PAST refs. A chain paused at any later checkpoint has by
  // definition finished refs, so it should render Done.
  it('marks broll_refs done when chain is paused_at_strategy', () => {
    const state = { parent: { auto_rough_cut: false, videos: [] }, subGroups: [{ broll_chain_status: 'paused_at_strategy', broll_chain_substage: 'strategy' }] }
    const stages = deriveStages(state)
    const refs = stages.find(s => s.id === 'broll_refs')
    expect(refs.done).toBe(true)
    expect(refs.active).toBe(false)
  })

  it('marks broll_refs + broll_strategy done when chain is paused_at_plan', () => {
    const state = { parent: { auto_rough_cut: false, videos: [] }, subGroups: [{ broll_chain_status: 'paused_at_plan', broll_chain_substage: 'plan' }] }
    const stages = deriveStages(state)
    expect(stages.find(s => s.id === 'broll_refs').done).toBe(true)
    expect(stages.find(s => s.id === 'broll_strategy').done).toBe(true)
    expect(stages.find(s => s.id === 'broll_plan').paused).toBe(true)
    expect(stages.find(s => s.id === 'broll_plan').done).toBe(false)
  })

  it('keeps refs Pending while chain is genuinely running on refs (not yet finished)', () => {
    const state = { parent: { auto_rough_cut: false, videos: [] }, subGroups: [{ broll_chain_status: 'running', broll_chain_substage: 'refs' }] }
    const stages = deriveStages(state)
    const refs = stages.find(s => s.id === 'broll_refs')
    expect(refs.done).toBe(false)
    expect(refs.active).toBe(true)
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

describe('ProcessingModal — review your rough cut banner condition', () => {
  const sg = (overrides) => ({ id: 1, rough_cut_status: 'done', broll_chain_status: 'running', ...overrides })

  it('returns true for hands-off + auto_rough_cut + RC done + chain running', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'hands-off', auto_rough_cut: true },
      subGroups: [sg()],
    })).toBe(true)
  })

  it('returns false when path_id is strategy-only', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'strategy-only', auto_rough_cut: true },
      subGroups: [sg()],
    })).toBe(false)
  })

  it('returns false when auto_rough_cut is off', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'hands-off', auto_rough_cut: false },
      subGroups: [sg()],
    })).toBe(false)
  })

  it('returns false when rough cut not yet done', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'hands-off', auto_rough_cut: true },
      subGroups: [sg({ rough_cut_status: 'running' })],
    })).toBe(false)
  })

  it('returns false when chain is fully done', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'hands-off', auto_rough_cut: true },
      subGroups: [sg({ broll_chain_status: 'done' })],
    })).toBe(false)
  })

  it('returns true when chain is paused at strategy (still in flight)', () => {
    expect(shouldShowReviewRoughCutBanner({
      parent: { path_id: 'hands-off', auto_rough_cut: true },
      subGroups: [sg({ broll_chain_status: 'paused_at_strategy' })],
    })).toBe(true)
  })
})

describe('ProcessingModal — strategy-only + auto_rough_cut pause', () => {
  it('treats paused_at_rough_cut on strategy-only as a rough-cut paused state', () => {
    const parent = {
      auto_rough_cut: true,
      path_id: 'strategy-only',
    }
    const subGroups = [{
      id: 1,
      assembly_status: 'done',
      rough_cut_status: 'done',
      broll_chain_status: 'paused_at_rough_cut',
    }]
    const stages = deriveStages({ parent, subGroups })
    const rc = stages.find(s => s.id === 'rough_cut')
    expect(rc.paused).toBe(true)
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
