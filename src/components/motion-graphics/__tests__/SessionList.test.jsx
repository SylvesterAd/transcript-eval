import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionList } from '../SessionList';

afterEach(cleanup);

describe('SessionList', () => {
  it('renders session titles', () => {
    const sessions = [
      { id: 1, title: 'EV explainer', status: 'iterating' },
      { id: 2, title: 'Ukraine map', status: 'briefing' },
    ];
    render(<SessionList sessions={sessions} activeId={null} onSelect={vi.fn()} onNew={vi.fn()} />);
    expect(screen.getByText('EV explainer')).toBeDefined();
    expect(screen.getByText('Ukraine map')).toBeDefined();
  });

  it('calls onNew when "New graphic" clicked', () => {
    const onNew = vi.fn();
    render(<SessionList sessions={[]} activeId={null} onSelect={vi.fn()} onNew={onNew} />);
    screen.getByRole('button', { name: /new graphic/i }).click();
    expect(onNew).toHaveBeenCalled();
  });
});
