import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { BRollFailureBanner } from '../EditorView.jsx'

afterEach(cleanup)

describe('<BRollFailureBanner />', () => {
  it('renders when chain failed at search substage (post-pause for strategy-only)', () => {
    render(<BRollFailureBanner status="failed" substage="search" pathId="strategy-only" />)
    // Vanilla matchers — jest-dom not installed.
    // getByText throws on miss, so reaching the assertion confirms presence.
    expect(screen.getByText(/b-roll auto-generation failed/i)).toBeTruthy()
    expect(screen.getByText(/search/i)).toBeTruthy()
  })

  it('renders when chain failed and path is null (manual mode)', () => {
    render(<BRollFailureBanner status="failed" substage="refs" pathId={null} />)
    expect(screen.getByText(/b-roll auto-generation failed/i)).toBeTruthy()
  })

  it('does not render when chain status is done', () => {
    const { container } = render(<BRollFailureBanner status="done" substage={null} pathId="hands-off" />)
    expect(container.firstChild).toBe(null)
  })

  it('does not render when chain status is null', () => {
    const { container } = render(<BRollFailureBanner status={null} substage={null} pathId="hands-off" />)
    expect(container.firstChild).toBe(null)
  })

  it('does not render hands-off failure (those go to FailedView in the loader instead)', () => {
    const { container } = render(<BRollFailureBanner status="failed" substage="refs" pathId="hands-off" />)
    expect(container.firstChild).toBe(null)
  })

  it('does not render strategy-only pre-pause failure (those go to FailedView)', () => {
    const { container } = render(<BRollFailureBanner status="failed" substage="strategy" pathId="strategy-only" />)
    expect(container.firstChild).toBe(null)
  })

  it('hides on dismiss', () => {
    render(<BRollFailureBanner status="failed" substage="search" pathId="strategy-only" />)
    expect(screen.queryByText(/b-roll auto-generation failed/i)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText(/b-roll auto-generation failed/i)).toBeNull()
  })
})
