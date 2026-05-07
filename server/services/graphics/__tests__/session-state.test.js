import { describe, it, expect } from 'vitest';
import { mergeSpec, isSpecComplete, REQUIRED_FIELDS } from '../session-state.js';

describe('mergeSpec', () => {
  it('merges new fields into existing spec', () => {
    const a = { aspectRatio: '16:9' };
    const b = { duration: 20 };
    expect(mergeSpec(a, b)).toEqual({ aspectRatio: '16:9', duration: 20 });
  });

  it('ignores null / undefined values from update', () => {
    expect(mergeSpec({ aspectRatio: '16:9' }, { aspectRatio: null })).toEqual({ aspectRatio: '16:9' });
  });

  it('overwrites scalar fields when update has a real value', () => {
    expect(mergeSpec({ duration: 10 }, { duration: 20 })).toEqual({ duration: 20 });
  });
});

describe('isSpecComplete', () => {
  it('false when any REQUIRED_FIELDS missing', () => {
    expect(isSpecComplete({})).toBe(false);
    expect(isSpecComplete({ aspectRatio: '16:9' })).toBe(false);
  });

  it('true when all REQUIRED_FIELDS present', () => {
    const full = Object.fromEntries(REQUIRED_FIELDS.map((f) => [f, 'x']));
    expect(isSpecComplete(full)).toBe(true);
  });
});
