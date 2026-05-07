import { describe, it, expect, afterEach } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import CutBar from '../CutBar.jsx'

// jest-dom is not installed — use vanilla matchers (toBeTruthy / not.toBeNull).
afterEach(cleanup)

describe('CutBar', () => {
  const baseProps = {
    x: 300,
    cutDuration: 20,
    origStart: 30,
    origEnd: 50,
    words: [],
  }

  it('renders a 4px wide purple bar at the given x position', () => {
    render(<CutBar {...baseProps} />)
    const bar = screen.getByTestId('cut-bar')
    expect(bar.style.left).toBe('300px')
    expect(bar.style.width).toBe('4px')
  })

  it('shows tooltip with cut duration', () => {
    render(<CutBar {...baseProps} />)
    expect(screen.getByTitle(/20\.0s removed/)).toBeTruthy()
  })

  it('opens side panel on click', () => {
    render(<CutBar {...baseProps} />)
    fireEvent.click(screen.getByTestId('cut-bar'))
    expect(screen.queryByTestId('cut-content-panel')).not.toBeNull()
  })

  it('side panel shows removed transcript text from words in cut range', () => {
    const words = [
      { word: 'before', start: 25, end: 28 },   // outside cut
      { word: 'inside1', start: 32, end: 35 },  // inside cut [30,50]
      { word: 'inside2', start: 35, end: 40 },  // inside cut
      { word: 'after', start: 55, end: 58 },    // outside cut
    ]
    render(<CutBar {...baseProps} words={words} />)
    fireEvent.click(screen.getByTestId('cut-bar'))
    const panel = screen.getByTestId('cut-content-panel')
    expect(panel.textContent).toContain('inside1')
    expect(panel.textContent).toContain('inside2')
    expect(panel.textContent).not.toContain('before')
    expect(panel.textContent).not.toContain('after')
  })

  it('side panel shows duration and original time range', () => {
    render(<CutBar {...baseProps} />)
    fireEvent.click(screen.getByTestId('cut-bar'))
    const panel = screen.getByTestId('cut-content-panel')
    expect(panel.textContent).toMatch(/20\.0s/)  // duration
    // Original time range — at minimum the start time appears somewhere
    expect(panel.textContent).toMatch(/30/)
    expect(panel.textContent).toMatch(/50/)
  })

  it('side panel closes on close-button click', () => {
    render(<CutBar {...baseProps} />)
    fireEvent.click(screen.getByTestId('cut-bar'))
    expect(screen.queryByTestId('cut-content-panel')).not.toBeNull()
    fireEvent.click(screen.getByTestId('cut-content-panel-close'))
    expect(screen.queryByTestId('cut-content-panel')).toBeNull()
  })

  it('side panel closes on second bar click (toggle)', () => {
    render(<CutBar {...baseProps} />)
    fireEvent.click(screen.getByTestId('cut-bar'))
    expect(screen.queryByTestId('cut-content-panel')).not.toBeNull()
    fireEvent.click(screen.getByTestId('cut-bar'))
    expect(screen.queryByTestId('cut-content-panel')).toBeNull()
  })
})
