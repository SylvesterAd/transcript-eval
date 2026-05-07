import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { RenderViewer } from '../RenderViewer';

afterEach(cleanup);

describe('RenderViewer', () => {
  it('shows queued status placeholder', () => {
    render(<RenderViewer render={{ id: 1, iteration: 1, status: 'queued' }} />);
    expect(screen.getByText(/queued/i)).toBeDefined();
  });

  it('shows failed message', () => {
    render(<RenderViewer render={{ id: 1, iteration: 1, status: 'failed', error_message: 'oops' }} />);
    expect(screen.getByText(/failed: oops/i)).toBeDefined();
  });

  it('renders video + download link when complete', () => {
    const r = { id: 1, iteration: 2, status: 'complete', output_url: 'https://x.example/out.mp4', duration_ms: 8400 };
    const { container } = render(<RenderViewer render={r} />);
    const video = container.querySelector('video');
    expect(video).toBeDefined();
    expect(video.getAttribute('src')).toBe('https://x.example/out.mp4');
    expect(screen.getByText(/download mp4/i)).toBeDefined();
  });
});
