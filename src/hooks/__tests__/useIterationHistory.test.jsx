import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const apiGetMock = vi.fn()
vi.mock('../useApi.js', () => ({
  apiGet: (...args) => apiGetMock(...args),
}))

beforeEach(() => {
  apiGetMock.mockReset()
})

const { useIterationHistory } = await import('../useIterationHistory.js')

describe('useIterationHistory', () => {
  it('starts idle (no fetch until load() called)', () => {
    const { result } = renderHook(() => useIterationHistory(42))
    expect(result.current.iterations).toBeNull()
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
    expect(apiGetMock).not.toHaveBeenCalled()
  })

  it('load() fetches iterations and updates state', async () => {
    apiGetMock.mockResolvedValueOnce([
      { id: 1, iteration_index: 0, frame_urls: [], critic_score: 0.5, critic_criteria: {}, critic_feedback: 'meh' },
    ])
    const { result } = renderHook(() => useIterationHistory(42))
    await act(async () => {
      await result.current.load()
    })
    expect(apiGetMock).toHaveBeenCalledWith('/graphics/renders/42/iterations')
    expect(result.current.iterations).toHaveLength(1)
    expect(result.current.iterations[0].critic_score).toBe(0.5)
    expect(result.current.loading).toBe(false)
  })

  it('load() sets loading true during fetch', async () => {
    let resolveFetch
    apiGetMock.mockImplementationOnce(
      () => new Promise((r) => { resolveFetch = r })
    )
    const { result } = renderHook(() => useIterationHistory(42))
    act(() => { result.current.load() })
    await waitFor(() => expect(result.current.loading).toBe(true))
    await act(async () => {
      resolveFetch([])
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
  })

  it('load() captures errors', async () => {
    apiGetMock.mockRejectedValueOnce(new Error('500 oops'))
    const { result } = renderHook(() => useIterationHistory(42))
    await act(async () => {
      await result.current.load()
    })
    expect(result.current.error).toBe('500 oops')
    expect(result.current.iterations).toBeNull()
  })

  it('second load() is a no-op once loaded', async () => {
    apiGetMock.mockResolvedValueOnce([{ id: 1, iteration_index: 0 }])
    const { result } = renderHook(() => useIterationHistory(42))
    await act(async () => { await result.current.load() })
    await act(async () => { await result.current.load() })
    expect(apiGetMock).toHaveBeenCalledTimes(1)
  })

  it('returns null iterations when renderId is missing (graceful)', () => {
    const { result } = renderHook(() => useIterationHistory(null))
    expect(result.current.iterations).toBeNull()
  })
})
