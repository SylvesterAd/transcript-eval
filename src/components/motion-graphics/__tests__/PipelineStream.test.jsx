// src/components/motion-graphics/__tests__/PipelineStream.test.jsx
import { render, screen, cleanup } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { PipelineStream } from '../PipelineStream'

afterEach(cleanup)

describe('PipelineStream', () => {
  it('renders nothing when no events', () => {
    const { container } = render(<PipelineStream events={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders each event with label + step + score when present', () => {
    render(<PipelineStream events={[
      { step: 'render_queued', label: 'Queued' },
      { step: 'critic_scored', label: 'Scored', score: 0.85 },
    ]} />)
    expect(screen.getByText('Queued')).toBeDefined()
    expect(screen.getByText('Scored')).toBeDefined()
    expect(screen.getByText('(0.85)')).toBeDefined()
  })
})
