import { describe, it, expect, vi, beforeEach } from 'vitest'

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

describe('runCritic — single scene (back-compat)', () => {
  beforeEach(() => { vi.resetModules() })

  it('makes one critic call when spec has no scenes array', async () => {
    const evalMock = vi.fn().mockResolvedValue({
      score: 0.85, criteria: {}, feedback: 'looks good', retry_recommended: false, tokens: { in: 100, out: 50 },
    })
    const extractMock = vi.fn().mockResolvedValue(['/tmp/f0.png', '/tmp/f1.png', '/tmp/f2.png', '/tmp/f3.png'])
    const uploadMock = vi.fn().mockResolvedValue([
      'http://supa/0', 'http://supa/1', 'http://supa/2', 'http://supa/3'
    ])
    vi.doMock('../evaluator.js', () => ({ evaluateFrames: evalMock }))
    vi.doMock('../frame-extractor.js', () => ({ extractFrames: extractMock }))
    vi.doMock('../../uploader.js', () => ({ uploadFrames: uploadMock }))
    vi.doMock('../../events/emitter.js', () => ({ emit: vi.fn() }))
    vi.doMock('../../../../db.js', () => ({
      default: { prepare: () => ({ run: vi.fn() }) },
    }))

    const { runCritic } = await import('../critic-runner.js')
    const result = await runCritic({
      renderId: 1, iterationIndex: 0,
      mp4Path: '/tmp/out.mp4', durationSec: 5,
      spec: { template: 'lower-third', duration: 5, mainText: 'X' },
      sessionId: 's',
    })
    expect(evalMock).toHaveBeenCalledTimes(1)
    expect(result.score).toBe(0.85)
    expect(result.feedback).toMatch(/looks good/)
    expect(result.retry_recommended).toBe(false)
  })
})

describe('runCritic — multi-scene aggregation', () => {
  beforeEach(() => { vi.resetModules() })

  it('runs one critic call per scene; aggregates score = min, feedback = scene-prefixed', async () => {
    const evalMock = vi.fn()
      .mockResolvedValueOnce({ score: 0.9, criteria: {}, feedback: 'crisp', retry_recommended: false, tokens: { in: 50, out: 25 } })
      .mockResolvedValueOnce({ score: 0.6, criteria: {}, feedback: 'too fast', retry_recommended: true, tokens: { in: 50, out: 25 } })
      .mockResolvedValueOnce({ score: 0.85, criteria: {}, feedback: 'good landing', retry_recommended: false, tokens: { in: 50, out: 25 } })
    const extractMock = vi.fn().mockImplementation(async ({ outDir }) => {
      return [`${outDir}/f0.png`, `${outDir}/f1.png`, `${outDir}/f2.png`, `${outDir}/f3.png`]
    })
    const uploadMock = vi.fn().mockResolvedValue(['http://supa/0', 'http://supa/1', 'http://supa/2', 'http://supa/3'])
    vi.doMock('../evaluator.js', () => ({ evaluateFrames: evalMock }))
    vi.doMock('../frame-extractor.js', () => ({ extractFrames: extractMock }))
    vi.doMock('../../uploader.js', () => ({ uploadFrames: uploadMock }))
    vi.doMock('../../events/emitter.js', () => ({ emit: vi.fn() }))
    vi.doMock('../../../../db.js', () => ({
      default: { prepare: () => ({ run: vi.fn() }) },
    }))

    const { runCritic } = await import('../critic-runner.js')
    const result = await runCritic({
      renderId: 2, iterationIndex: 0,
      mp4Path: '/tmp/out.mp4', durationSec: 11,
      spec: {
        aspectRatio: '16:9', tone: 'analytical',
        scenes: [
          { template: 'opener', duration: 3, mainText: 'A', subText: 'kicker' },
          { template: 'stat', duration: 4, mainText: '187', subText: 'PERCENT GROWTH' },
          { template: 'cta', duration: 4, mainText: 'READ FULL STORY' },
        ],
      },
      sessionId: 's',
    })

    expect(evalMock).toHaveBeenCalledTimes(3)
    expect(result.score).toBe(0.6)
    expect(result.feedback).toMatch(/Scene 1:.*crisp/)
    expect(result.feedback).toMatch(/Scene 2:.*too fast/)
    expect(result.feedback).toMatch(/Scene 3:.*good landing/)
    expect(result.retry_recommended).toBe(true)
  })
})
