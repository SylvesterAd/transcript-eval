import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    cb(null, { stdout: '', stderr: '' })
  }),
}))
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises')
  return { ...real, mkdir: vi.fn().mockResolvedValue(undefined) }
})

describe('extractFrames', () => {
  it('returns N evenly-spaced frame paths', async () => {
    const { extractFrames } = await import('../frame-extractor.js')
    const result = await extractFrames({
      mp4Path: '/tmp/x.mp4',
      durationSec: 5,
      count: 4,
      outDir: '/tmp/frames',
    })
    expect(result).toHaveLength(4)
    expect(result[0]).toMatch(/\/tmp\/frames\/frame-0\.png$/)
    expect(result[3]).toMatch(/\/tmp\/frames\/frame-3\.png$/)
  })

  it('throws when count < 1', async () => {
    const { extractFrames } = await import('../frame-extractor.js')
    await expect(
      extractFrames({ mp4Path: '/tmp/x.mp4', durationSec: 5, count: 0, outDir: '/tmp' })
    ).rejects.toThrow(/count/i)
  })
})
