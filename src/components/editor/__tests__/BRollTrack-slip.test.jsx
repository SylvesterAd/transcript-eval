import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import BRollTrack from '../BRollTrack.jsx'

afterEach(cleanup)

const placement = {
  uuid: 'p1',
  filename: 'pexels_test.mp4',
  timelineStart: 10,
  timelineEnd: 15,
  timelineDuration: 5.0,
  source_in_seconds: 0,
  sourceDurationSeconds: 12.0,
  sourceFrameRate: 29.97,
}

// BRollTrack needs overridePlacements to render without BRollContext.
// zoom is required for pixel math; without it the bars would collapse.
function renderTrack(extraProps = {}) {
  return render(
    <BRollTrack
      placements={[placement]}
      overridePlacements={extraProps.overridePlacements !== undefined ? extraProps.overridePlacements : [placement]}
      zoom={10}
      slipPlacement={extraProps.slipPlacement || (() => {})}
      toggleKeepOriginal={extraProps.toggleKeepOriginal || (() => {})}
      onPreviewSeek={extraProps.onPreviewSeek || (() => {})}
      {...extraProps}
    />
  )
}

describe('BRollTrack double-click expansion', () => {
  it('opens BRollSlipPanel on double-click of a placement bar', () => {
    renderTrack()
    expect(screen.queryByTestId('slip-source-strip')).toBeNull()
    const bar = screen.getByTestId(`broll-bar-${placement.uuid}`)
    fireEvent.doubleClick(bar)
    expect(screen.getByTestId('slip-source-strip')).toBeTruthy()
  })

  it('double-clicking same placement again closes the panel', () => {
    renderTrack()
    const bar = screen.getByTestId(`broll-bar-${placement.uuid}`)
    fireEvent.doubleClick(bar)
    fireEvent.doubleClick(bar)
    expect(screen.queryByTestId('slip-source-strip')).toBeNull()
  })

  it('double-clicking a second placement closes the first panel', () => {
    const p2 = { ...placement, uuid: 'p2', filename: 'b.mp4', timelineStart: 20, timelineEnd: 25 }
    render(
      <BRollTrack
        overridePlacements={[placement, p2]}
        zoom={10}
        slipPlacement={() => {}}
        toggleKeepOriginal={() => {}}
        onPreviewSeek={() => {}}
      />
    )
    fireEvent.doubleClick(screen.getByTestId(`broll-bar-${placement.uuid}`))
    fireEvent.doubleClick(screen.getByTestId(`broll-bar-${p2.uuid}`))
    const panels = screen.queryAllByTestId('slip-source-strip')
    expect(panels.length).toBe(1)
  })

  it('Esc closes an open panel', () => {
    renderTrack()
    fireEvent.doubleClick(screen.getByTestId(`broll-bar-${placement.uuid}`))
    expect(screen.getByTestId('slip-source-strip')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('slip-source-strip')).toBeNull()
  })
})

describe('BRollTrack badges', () => {
  it('shows clock icon on auto-clamped placements', () => {
    const clamped = { ...placement, auto_clamp_applied: true }
    render(
      <BRollTrack
        overridePlacements={[clamped]}
        zoom={10}
        slipPlacement={() => {}}
        toggleKeepOriginal={() => {}}
        onPreviewSeek={() => {}}
        onPreviewClear={() => {}}
      />
    )
    expect(screen.getByTestId(`broll-bar-${clamped.uuid}-clock`)).toBeTruthy()
  })

  it('shows slip indicator on placements with source_in_seconds > 0', () => {
    const slipped = { ...placement, source_in_seconds: 1.5 }
    render(
      <BRollTrack
        overridePlacements={[slipped]}
        zoom={10}
        slipPlacement={() => {}}
        toggleKeepOriginal={() => {}}
        onPreviewSeek={() => {}}
        onPreviewClear={() => {}}
      />
    )
    expect(screen.getByTestId(`broll-bar-${slipped.uuid}-slip`)).toBeTruthy()
  })

  it('does not show badges on a default placement', () => {
    render(
      <BRollTrack
        overridePlacements={[placement]}
        zoom={10}
        slipPlacement={() => {}}
        toggleKeepOriginal={() => {}}
        onPreviewSeek={() => {}}
        onPreviewClear={() => {}}
      />
    )
    expect(screen.queryByTestId(`broll-bar-${placement.uuid}-clock`)).toBeNull()
    expect(screen.queryByTestId(`broll-bar-${placement.uuid}-slip`)).toBeNull()
  })
})
