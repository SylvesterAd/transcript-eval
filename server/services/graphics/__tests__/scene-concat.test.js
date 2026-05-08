import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => cb(null, { stdout: '', stderr: '' })),
}))
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises')
  return { ...real, writeFile: vi.fn().mockResolvedValue(undefined), mkdir: vi.fn().mockResolvedValue(undefined) }
})

describe('concatScenes', () => {
  it('writes manifest and runs ffmpeg concat', async () => {
    const { concatScenes } = await import('../scene-concat.js')
    const { writeFile } = await import('node:fs/promises')
    const cp = await import('node:child_process')
    const r = await concatScenes({ sceneMp4Paths: ['/tmp/r/s0.mp4', '/tmp/r/s1.mp4'], outputPath: '/tmp/r/final.mp4' })
    expect(r.outputPath).toBe('/tmp/r/final.mp4')
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
    const manifestCall = writeFile.mock.calls.find((c) => /\.txt$/.test(c[0]))
    expect(manifestCall).toBeDefined()
    expect(manifestCall[1]).toContain("file '/tmp/r/s0.mp4'")
    expect(manifestCall[1]).toContain("file '/tmp/r/s1.mp4'")
    const ffArgs = cp.execFile.mock.calls[0][1]
    expect(ffArgs).toEqual(expect.arrayContaining(['-y', '-f', 'concat', '-safe', '0', '-c', 'copy', '/tmp/r/final.mp4']))
  })
  it('throws on empty input', async () => {
    const { concatScenes } = await import('../scene-concat.js')
    await expect(concatScenes({ sceneMp4Paths: [], outputPath: '/tmp/x.mp4' })).rejects.toThrow(/at least one/i)
  })
})
