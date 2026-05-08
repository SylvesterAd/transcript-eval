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

describe('isSpecComplete (multi-scene)', () => {
  it('multi-scene complete', async () => {
    const { isSpecComplete } = await import('../session-state.js')
    expect(isSpecComplete({
      aspectRatio: '16:9', tone: 'neutral',
      scenes: [
        { template: 'lower-third', duration: 3, mainText: 'A', subText: 'a' },
        { template: 'lower-third', duration: 5, mainText: 'B', subText: 'b' },
      ],
    })).toBe(true)
  })
  it('multi-scene incomplete: scene missing field', async () => {
    const { isSpecComplete } = await import('../session-state.js')
    expect(isSpecComplete({
      aspectRatio: '16:9', tone: 'neutral',
      scenes: [{ template: 'lower-third', duration: 3, mainText: 'A' }],
    })).toBe(false)
  })
  it('multi-scene incomplete: top-level missing aspectRatio', async () => {
    const { isSpecComplete } = await import('../session-state.js')
    expect(isSpecComplete({
      tone: 'neutral',
      scenes: [{ template: 'lower-third', duration: 3, mainText: 'A', subText: 'a' }],
    })).toBe(false)
  })
  it('single-scene back-compat', async () => {
    const { isSpecComplete } = await import('../session-state.js')
    expect(isSpecComplete({
      template: 'lower-third', aspectRatio: '16:9', duration: 5,
      mainText: 'A', subText: 'a', tone: 'neutral',
    })).toBe(true)
  })
})

describe('isSpecComplete with canonical multi-scene', () => {
  it('rejects spec where any scene is missing template', async () => {
    const { isSpecComplete } = await import('../session-state.js')
    const spec = {
      aspectRatio: '16:9',
      tone: 'neutral',
      scenes: [
        { template: 'lower-third', duration: 3, mainText: 'A', subText: 'a' },
        { duration: 3, mainText: 'B', subText: 'b' }, // missing template
      ],
    }
    expect(isSpecComplete(spec)).toBe(false)
  })

  it('accepts canonical multi-scene with all required fields', async () => {
    const { isSpecComplete } = await import('../session-state.js')
    const spec = {
      aspectRatio: '16:9',
      tone: 'neutral',
      scenes: [
        { template: 'lower-third', duration: 3, mainText: 'A', subText: 'a' },
        { template: 'lower-third', duration: 3, mainText: 'B', subText: 'b' },
      ],
    }
    expect(isSpecComplete(spec)).toBe(true)
  })
})

describe('isMultiScene', () => {
  it('returns true if scenes is non-empty array', async () => {
    const { isMultiScene } = await import('../session-state.js')
    expect(isMultiScene({ scenes: [{ template: 'x', duration: 3, mainText: 't' }] })).toBe(true)
    expect(isMultiScene({ scenes: [] })).toBe(false)
    expect(isMultiScene({})).toBe(false)
  })
})
