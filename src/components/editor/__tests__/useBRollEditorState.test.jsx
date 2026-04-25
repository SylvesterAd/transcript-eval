import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../lib/supabaseClient.js', () => ({ supabase: null }))
vi.mock('../EditorView.jsx', () => ({ EditorContext: { Provider: ({ children }) => children, _currentValue: null } }))

import { useBRollEditorState } from '../useBRollEditorState.js'

// Render-hook helper for happy-dom + React 19.
export function renderHook(hookFn) {
  const result = { current: null }
  function HookHost() {
    result.current = hookFn()
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(createElement(HookHost)) })
  return {
    result,
    rerender: () => act(() => { root.render(createElement(HookHost)) }),
    unmount: () => { act(() => root.unmount()); container.remove() },
  }
}

describe('useBRollEditorState — surface', () => {
  beforeEach(() => { globalThis.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 })) })
  afterEach(() => { vi.restoreAllMocks() })

  it('exposes dragCrossPlacement and undo as functions', () => {
    const { result } = renderHook(() => useBRollEditorState('pipe-A'))
    expect(typeof result.current.dragCrossPlacement).toBe('function')
    expect(typeof result.current.undo).toBe('function')
    expect(typeof result.current.redo).toBe('function')
  })
})
