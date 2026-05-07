import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: (cmd, args, opts, cb) => {
    // simulate async execFile callback signature
    process.nextTick(() => {
      const stdout = JSON.stringify({
        errorCount: 0,
        warningCount: 1,
        infoCount: 0,
        findings: [
          { severity: 'warn', rule: 'animation-baseline.eases', message: 'only 2 eases used' },
        ],
      })
      cb(null, { stdout, stderr: '' })
    })
  },
}))

beforeEach(() => {
  vi.resetModules()
})

describe('runLint', () => {
  it('returns parsed { errorCount, warningCount, findings } from hyperframes lint --json', async () => {
    const { runLint } = await import('../lint-runner.js')
    const result = await runLint({ htmlPath: '/tmp/test.html' })
    expect(result.errorCount).toBe(0)
    expect(result.warningCount).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].rule).toBe('animation-baseline.eases')
  })

  it('throws on missing htmlPath', async () => {
    const { runLint } = await import('../lint-runner.js')
    await expect(runLint({})).rejects.toThrow(/htmlPath/)
  })
})

describe('runLint with errors', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      execFile: (cmd, args, opts, cb) => {
        process.nextTick(() => {
          const stdout = JSON.stringify({
            errorCount: 2,
            warningCount: 0,
            infoCount: 0,
            findings: [
              { severity: 'error', rule: 'determinism.banned-api', message: 'Math.random() detected' },
              { severity: 'error', rule: 'stage-marker', message: 'no data-composition-id="main"' },
            ],
          })
          cb(null, { stdout, stderr: '' })
        })
      },
    }))
  })

  it('reports error count + findings', async () => {
    const { runLint } = await import('../lint-runner.js')
    const result = await runLint({ htmlPath: '/tmp/test.html' })
    expect(result.errorCount).toBe(2)
    expect(result.findings).toHaveLength(2)
  })
})
