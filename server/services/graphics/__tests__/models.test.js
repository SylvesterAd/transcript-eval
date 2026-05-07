import { describe, it, expect } from 'vitest';
import { MODEL_FOR, costCents } from '../models.js';

describe('model router', () => {
  it('maps step roles to specific model IDs', () => {
    expect(MODEL_FOR.brief).toBe('gemini-3-flash-preview');
    expect(MODEL_FOR.create).toBe('claude-opus-4-7');
    expect(MODEL_FOR.review).toBe('claude-opus-4-7');
    expect(MODEL_FOR.classify).toBe('gemini-3-flash-preview');
  });

  it('costs claude-opus-4-7 input at $15 / M tokens (1500 cents)', () => {
    expect(costCents('claude-opus-4-7', { in: 1_000_000, out: 0 })).toBe(1500);
  });

  it('costs gemini-3-flash output at $3 / M tokens', () => {
    expect(costCents('gemini-3-flash-preview', { in: 0, out: 1_000_000 })).toBe(300);
  });

  it('rounds fractional costs up to nearest cent', () => {
    // 1k input tokens × 50 cents/M = 0.05 cents → ceil → 1
    expect(costCents('gemini-3-flash-preview', { in: 1000, out: 0 })).toBe(1);
  });
});
