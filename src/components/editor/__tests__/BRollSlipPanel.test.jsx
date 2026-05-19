import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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
