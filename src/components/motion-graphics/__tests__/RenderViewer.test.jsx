import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';

const apiGetMock = vi.fn()
vi.mock('../../../hooks/useApi.js', () => ({
  apiGet: (...args) => apiGetMock(...args),
}))

beforeEach(() => { apiGetMock.mockReset() })
afterEach(cleanup);

const { RenderViewer } = await import('../RenderViewer.jsx');

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
    const r = { id: 1, iteration: 2, status: 'complete', output_url: 'https://x.example/out.mp4', duration_ms: 8400, iteration_count: 1 };
    const { container } = render(<RenderViewer render={r} />);
    const video = container.querySelector('video');
    expect(video).toBeDefined();
    expect(video.getAttribute('src')).toBe('https://x.example/out.mp4');
    expect(screen.getByText(/download mp4/i)).toBeDefined();
  });

  it('does NOT show iteration toggle when iteration_count <= 1', () => {
    const r = { id: 1, iteration: 2, status: 'complete', output_url: 'https://x/out.mp4', duration_ms: 1000, iteration_count: 1 };
    render(<RenderViewer render={r} />);
    expect(screen.queryByText(/view .* iteration/i)).toBeNull();
  });

  it('shows iteration toggle when iteration_count > 1', () => {
    const r = { id: 5, iteration: 2, status: 'complete', output_url: 'https://x/out.mp4', duration_ms: 1000, iteration_count: 3 };
    render(<RenderViewer render={r} />);
    expect(screen.getByText(/view 3 iterations/i)).toBeDefined();
  });

  it('expanding the toggle fetches iterations and renders the panel', async () => {
    apiGetMock.mockResolvedValueOnce([
      { id: 11, iteration_index: 0, frame_urls: [], critic_score: 0.4, critic_criteria: { fidelity: 0.4, legibility: 0.4, style: 0.4, timing: 0.4 }, critic_feedback: 'fa' },
      { id: 12, iteration_index: 1, frame_urls: [], critic_score: 0.85, critic_criteria: { fidelity: 0.9, legibility: 0.9, style: 0.8, timing: 0.8 }, critic_feedback: 'fb' },
    ])
    const r = { id: 5, iteration: 2, status: 'complete', output_url: 'https://x/out.mp4', duration_ms: 1000, iteration_count: 2 };
    render(<RenderViewer render={r} />);
    fireEvent.click(screen.getByText(/view 2 iterations/i));
    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/graphics/renders/5/iterations');
      expect(screen.getByText(/iteration 0/i)).toBeDefined();
      expect(screen.getByText(/iteration 1/i)).toBeDefined();
    });
    expect(screen.getByText(/hide iterations/i)).toBeDefined();
  });
});
