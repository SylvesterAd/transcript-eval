import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { vi } from 'vitest'
import BRollSlipPanel from '../BRollSlipPanel.jsx'

afterEach(cleanup)

const placement = {
  uuid: 'p1',
  filename: 'test.mp4',
  timelineStart: 10,
  timelineDuration: 5.0,
  source_in_seconds: 1.0,
  keep_original_duration: false,
  original_timeline_duration: 5.0,
  sourceDurationSeconds: 12.0,
  sourceFrameRate: 29.97,
}

describe('BRollSlipPanel rendering', () => {
  it('renders a source strip with data-source-duration', () => {
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const strip = screen.getByTestId('slip-source-strip')
    expect(strip).toBeTruthy()
    expect(strip.dataset.sourceDuration).toBe('12')
  })

  it('renders a green window at source_in_seconds → source_in_seconds+effectiveDuration', () => {
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const window = screen.getByTestId('slip-green-window')
    expect(window.dataset.windowStart).toBe('1')
    expect(window.dataset.windowEnd).toBe('6')
  })

  it('renders Keep original duration checkbox reflecting current state', () => {
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const cb = screen.getByLabelText(/keep original duration/i)
    expect(cb).toBeTruthy()
    expect(cb.checked).toBe(false)
  })

  it('renders Reset button', () => {
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: /reset/i })).toBeTruthy()
  })

  it('renders Close button', () => {
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: /close/i })).toBeTruthy()
  })

  it('renders overflow stripe when keep_original_duration=true and window extends past source', () => {
    const overflowPlacement = {
      ...placement,
      keep_original_duration: true,
      source_in_seconds: 8.0,
      original_timeline_duration: 7.0, // 8 + 7 = 15, past source dur 12
    }
    render(
      <BRollSlipPanel
        placement={overflowPlacement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    expect(screen.queryByTestId('slip-overflow-stripe')).toBeTruthy()
  })

  it('does NOT render overflow stripe when clamp is on (default)', () => {
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={() => {}}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    expect(screen.queryByTestId('slip-overflow-stripe')).toBeNull()
  })
})

describe('BRollSlipPanel drag interaction', () => {
  it('mouse-drag on green window commits new source_in_seconds on mouseup', () => {
    const onSlipChange = vi.fn()
    const onPreviewSeek = vi.fn()
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={onSlipChange}
        onClampToggle={() => {}}
        onPreviewSeek={onPreviewSeek}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const win = screen.getByTestId('slip-green-window')
    const strip = screen.getByTestId('slip-source-strip')
    // Mock getBoundingClientRect for deterministic px math
    strip.getBoundingClientRect = () => ({ left: 0, width: 1200, right: 1200, top: 0, bottom: 48, height: 48, x: 0, y: 0, toJSON: () => ({}) })

    fireEvent.mouseDown(win, { clientX: 200 })
    fireEvent.mouseMove(document, { clientX: 300 })
    fireEvent.mouseUp(document, { clientX: 300 })

    // sourceDur=12s, strip width=1200px → pxPerSecond=100. Drag delta = 100px = 1s.
    // placement.source_in_seconds starts at 1.0 → ends at 2.0
    expect(onSlipChange).toHaveBeenCalledTimes(1)
    const newSourceIn = onSlipChange.mock.calls[0][0]
    expect(newSourceIn).toBeCloseTo(2.0, 1)
  })

  it('respects upper bound when clamp is on (max sourceIn = sourceDur - effectiveDuration)', () => {
    const onSlipChange = vi.fn()
    // source_in=6, effectiveDur=5, sourceDur=12 → max sourceIn = 7
    render(
      <BRollSlipPanel
        placement={{ ...placement, source_in_seconds: 6 }}
        onSlipChange={onSlipChange}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const win = screen.getByTestId('slip-green-window')
    const strip = screen.getByTestId('slip-source-strip')
    strip.getBoundingClientRect = () => ({ left: 0, width: 1200, right: 1200, top: 0, bottom: 48, height: 48, x: 0, y: 0, toJSON: () => ({}) })

    fireEvent.mouseDown(win, { clientX: 600 })
    fireEvent.mouseMove(document, { clientX: 1100 })
    fireEvent.mouseUp(document, { clientX: 1100 })

    expect(onSlipChange).toHaveBeenCalledTimes(1)
    const finalIn = onSlipChange.mock.calls[0][0]
    expect(finalIn).toBeLessThanOrEqual(7)
  })

  it('respects lower bound: source_in cannot go negative', () => {
    const onSlipChange = vi.fn()
    render(
      <BRollSlipPanel
        placement={{ ...placement, source_in_seconds: 0.5 }}
        onSlipChange={onSlipChange}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const win = screen.getByTestId('slip-green-window')
    const strip = screen.getByTestId('slip-source-strip')
    strip.getBoundingClientRect = () => ({ left: 0, width: 1200, right: 1200, top: 0, bottom: 48, height: 48, x: 0, y: 0, toJSON: () => ({}) })

    fireEvent.mouseDown(win, { clientX: 100 })
    fireEvent.mouseMove(document, { clientX: 0 }) // big left drag — past 0
    fireEvent.mouseUp(document, { clientX: 0 })

    expect(onSlipChange).toHaveBeenCalledTimes(1)
    expect(onSlipChange.mock.calls[0][0]).toBeGreaterThanOrEqual(0)
  })

  it('does not call onSlipChange if drag delta resolves to no change', () => {
    const onSlipChange = vi.fn()
    render(
      <BRollSlipPanel
        placement={placement}
        onSlipChange={onSlipChange}
        onClampToggle={() => {}}
        onPreviewSeek={() => {}}
        onReset={() => {}}
        onClose={() => {}}
      />
    )
    const win = screen.getByTestId('slip-green-window')
    const strip = screen.getByTestId('slip-source-strip')
    strip.getBoundingClientRect = () => ({ left: 0, width: 1200, right: 1200, top: 0, bottom: 48, height: 48, x: 0, y: 0, toJSON: () => ({}) })

    fireEvent.mouseDown(win, { clientX: 200 })
    fireEvent.mouseUp(document, { clientX: 200 }) // no move

    expect(onSlipChange).not.toHaveBeenCalled()
  })
})
