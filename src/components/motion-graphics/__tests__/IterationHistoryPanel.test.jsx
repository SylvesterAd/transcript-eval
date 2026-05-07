import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { IterationHistoryPanel } from '../IterationHistoryPanel.jsx'

afterEach(cleanup)

const sample = [
  {
    id: 1,
    iteration_index: 0,
    frame_urls: ['https://x/0a.png', 'https://x/0b.png', 'https://x/0c.png', 'https://x/0d.png'],
    critic_score: 0.45,
    critic_criteria: { fidelity: 0.5, legibility: 0.6, style: 0.4, timing: 0.3 },
    critic_feedback: 'frames too dim, text overflows',
  },
  {
    id: 2,
    iteration_index: 1,
    frame_urls: ['https://x/1a.png', 'https://x/1b.png', 'https://x/1c.png', 'https://x/1d.png'],
    critic_score: 0.85,
    critic_criteria: { fidelity: 0.9, legibility: 0.85, style: 0.8, timing: 0.85 },
    critic_feedback: 'looks good',
  },
]

describe('IterationHistoryPanel', () => {
  it('renders one card per iteration', () => {
    render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    expect(screen.getByText(/iteration 0/i)).toBeDefined()
    expect(screen.getByText(/iteration 1/i)).toBeDefined()
  })

  it('shows score for each iteration', () => {
    render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    expect(screen.getAllByText(/0\.45/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/0\.85/).length).toBeGreaterThan(0)
  })

  it('renders 4 frame thumbnails per card', () => {
    const { container } = render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    const imgs = container.querySelectorAll('img')
    expect(imgs.length).toBe(8)
    expect(imgs[0].getAttribute('src')).toBe('https://x/0a.png')
    expect(imgs[4].getAttribute('src')).toBe('https://x/1a.png')
  })

  it('marks best (highest-score) iteration', () => {
    render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    const best = screen.getByText(/best/i)
    expect(best).toBeDefined()
  })

  it('renders feedback paragraph', () => {
    render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    expect(screen.getByText(/frames too dim/i)).toBeDefined()
    expect(screen.getByText(/looks good/i)).toBeDefined()
  })

  it('shows criteria values', () => {
    render(<IterationHistoryPanel iterations={sample} loading={false} error={null} />)
    expect(screen.getAllByText(/fidelity/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/legibility/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/style/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/timing/i).length).toBeGreaterThan(0)
  })

  it('shows loading state', () => {
    render(<IterationHistoryPanel iterations={null} loading={true} error={null} />)
    expect(screen.getByText(/loading/i)).toBeDefined()
  })

  it('shows error state', () => {
    render(<IterationHistoryPanel iterations={null} loading={false} error="500 oops" />)
    expect(screen.getByText(/500 oops/i)).toBeDefined()
  })

  it('shows empty state when iterations is empty array', () => {
    render(<IterationHistoryPanel iterations={[]} loading={false} error={null} />)
    expect(screen.getByText(/no iterations/i)).toBeDefined()
  })
})
