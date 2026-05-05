import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import StepRoughCut from '../steps/StepRoughCut.jsx'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  global.fetch = vi.fn(async (url) => {
    if (url.endsWith('/estimate-ai-roughcut')) {
      return { ok: true, json: async () => ({ tokenCost: 1200, estimatedTimeSeconds: 900, balance: 5000, sufficient: true, durationSeconds: 2400 }) }
    }
    if (url.endsWith('/user/tokens')) {
      return { ok: true, json: async () => ({ balance: 5000 }) }
    }
    throw new Error(`unmocked fetch: ${url}`)
  })
})

describe('StepRoughCut', () => {
  // The Skip/Run radios were removed in commit e3dd455 — the choice
  // moved to footer CTAs in UploadConfigFlow. The component is now
  // purely informational + estimate-display + validity-gate; the tests
  // below cover what remains as StepRoughCut's responsibility.

  it('reports validity=true when autoRoughCut is false (skip path is always valid)', async () => {
    const onValidity = vi.fn()
    render(
      <StepRoughCut
        groupId={1}
        state={{ autoRoughCut: false }}
        setState={{ autoRoughCut: () => {} }}
        onValidityChange={onValidity}
      />
    )
    await waitFor(() => expect(onValidity).toHaveBeenCalledWith(true))
  })

  it('shows the estimate token count after the server responds', async () => {
    render(
      <StepRoughCut
        groupId={1}
        state={{ autoRoughCut: true }}
        setState={{ autoRoughCut: () => {} }}
      />
    )
    await waitFor(() => expect(screen.getAllByText(/1,200/).length).toBeGreaterThan(0))
  })

  it('exposes balance shortfall via onValidityChange when balance < cost', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tokenCost: 1200, estimatedTimeSeconds: 900, balance: 50, sufficient: false, durationSeconds: 2400 }),
    }))
    const onValidity = vi.fn()
    render(
      <StepRoughCut
        groupId={1}
        state={{ autoRoughCut: true }}
        setState={{ autoRoughCut: () => {} }}
        onValidityChange={onValidity}
      />
    )
    await waitFor(() => expect(onValidity).toHaveBeenCalledWith(false))
    expect(screen.getByText(/Not enough tokens/i)).toBeTruthy()
  })
})
