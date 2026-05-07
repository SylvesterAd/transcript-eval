import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { ChatThread } from '../ChatThread';

afterEach(cleanup);

describe('ChatThread', () => {
  it('renders user + assistant messages', () => {
    const messages = [
      { id: 1, role: 'user', content: 'I want a lower-third', cost_cents: 0 },
      { id: 2, role: 'assistant', content: 'What aspect ratio?', cost_cents: 1, model_used: 'gemini-3-flash-preview' },
    ];
    render(<ChatThread messages={messages} renders={[]} />);
    expect(screen.getByText('I want a lower-third')).toBeDefined();
    expect(screen.getByText('What aspect ratio?')).toBeDefined();
  });

  it('renders queued render in its placeholder form', () => {
    render(<ChatThread messages={[]} renders={[{ id: 5, iteration: 1, status: 'queued' }]} />);
    expect(screen.getByText(/render #1/i)).toBeDefined();
  });
});
