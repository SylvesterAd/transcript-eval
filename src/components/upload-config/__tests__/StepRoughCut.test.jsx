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
  it('defaults to Skip', () => {
    render(<StepRoughCut groupId={1} state={{ autoRoughCut: false }} setState={{ autoRoughCut: () => {} }} />)
    const skip = screen.getByRole('radio', { name: /skip/i })
    expect(skip.checked).toBe(true)
  })

  it('shows estimate from server when Run is selected', async () => {
    const setAutoRoughCut = vi.fn()
    const { rerender } = render(
      <StepRoughCut groupId={1} state={{ autoRoughCut: false }} setState={{ autoRoughCut: setAutoRoughCut }} />
    )
    fireEvent.click(screen.getByRole('radio', { name: /run/i }))
    rerender(<StepRoughCut groupId={1} state={{ autoRoughCut: true }} setState={{ autoRoughCut: setAutoRoughCut }} />)
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
