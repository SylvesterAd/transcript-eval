import { describe, it, expect, vi } from 'vitest'

vi.mock('../../events/emitter.js', () => ({ emit: vi.fn() }))

vi.mock('../frame-extractor.js', () => ({
  extractFrames: vi.fn().mockResolvedValue(['/tmp/f0.png', '/tmp/f1.png', '/tmp/f2.png', '/tmp/f3.png']),
}))
vi.mock('../evaluator.js', () => ({
  evaluateFrames: vi.fn().mockResolvedValue({
    score: 0.82,
    criteria: { fidelity: 0.85, legibility: 0.8, style: 0.85, timing: 0.78 },
    feedback: 'Title fits, sub-text could be larger.',
    retry_recommended: false,
    tokens: { in: 1200, out: 80 },
  }),
}))
vi.mock('../../uploader.js', () => ({
  uploadFrames: vi.fn().mockResolvedValue([
    'https://x/0.png', 'https://x/1.png', 'https://x/2.png', 'https://x/3.png',
  ]),
}))
vi.mock('../../../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ lastInsertRowid: 99, changes: 1 }),
      get: vi.fn().mockResolvedValue({ id: 99 }),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

describe('runCritic', () => {
  it('extracts → evaluates → uploads → persists, returns the critique', async () => {
    const { runCritic } = await import('../critic-runner.js')
    const result = await runCritic({
      renderId: 7,
      iterationIndex: 1,
      mp4Path: '/tmp/render.mp4',
      durationSec: 5,
      spec: { template: 'lower-third', mainText: 'Anna' },
      sessionId: 1,
    })
    expect(result.score).toBe(0.82)
    expect(result.retry_recommended).toBe(false)
    expect(result.frameUrls).toHaveLength(4)
  })
})
