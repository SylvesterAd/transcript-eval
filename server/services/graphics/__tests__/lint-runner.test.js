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
    const result = await runLint({ projectDir: '/tmp/test-proj' })
    expect(result.errorCount).toBe(0)
    expect(result.warningCount).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].rule).toBe('animation-baseline.eases')
  })

  it('throws on missing projectDir', async () => {
    const { runLint } = await import('../lint-runner.js')
    await expect(runLint({})).rejects.toThrow(/projectDir/)
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
    const result = await runLint({ projectDir: '/tmp/test-proj' })
    expect(result.errorCount).toBe(2)
    expect(result.findings).toHaveLength(2)
  })
})

describe('runLint with non-zero exit (errors found)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      execFile: (cmd, args, opts, cb) => {
        process.nextTick(() => {
          // Simulate hyperframes lint exiting non-zero when errors found,
          // BUT still emitting the JSON payload to stdout (lint CLI convention).
          const stdout = JSON.stringify({
            errorCount: 1,
            warningCount: 0,
            infoCount: 0,
            findings: [
              { severity: 'error', rule: 'determinism.banned-api', message: 'Math.random() detected' },
            ],
          })
          const err = Object.assign(new Error('Command failed: npx hyperframes lint'), {
            code: 1,
            stdout,
            stderr: '',
          })
          cb(err)
        })
      },
    }))
  })

  it('returns structured findings even when subprocess exits non-zero', async () => {
    const { runLint } = await import('../lint-runner.js')
    const result = await runLint({ projectDir: '/tmp/test-proj' })
    expect(result.errorCount).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].rule).toBe('determinism.banned-api')
  })
})

describe('runLint with malformed stdout (no JSON anywhere)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      execFile: (cmd, args, opts, cb) => {
        process.nextTick(() => {
          cb(null, { stdout: 'not-json-just-a-banner-line\n', stderr: '' })
        })
      },
    }))
  })

  it('throws a contextual error when no JSON object is present', async () => {
    const { runLint } = await import('../lint-runner.js')
    await expect(runLint({ projectDir: '/tmp/test-proj' })).rejects.toThrow(
      /no JSON object found in hyperframes lint output/
    )
  })
})

describe('runLint tolerates non-JSON prefix (telemetry banner)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('node:child_process', () => ({
      execFile: (cmd, args, opts, cb) => {
        process.nextTick(() => {
          // Real hyperframes CLI first-run output: telemetry banner before the
          // JSON payload. This was the root cause of the session-73 lint
          // failure — JSON.parse(stdout) choked on the "Hyperframes …" prefix.
          const stdout =
            '\n  Hyperframes collects anonymous usage data to improve the tool.\n' +
            '  No personal info, file paths, or content is collected.\n\n' +
            '  Disable anytime: hyperframes telemetry disable\n\n' +
            JSON.stringify({
              ok: false,
              errorCount: 1,
              warningCount: 0,
              infoCount: 0,
              findings: [
                { severity: 'error', rule: 'missing_timeline_registry', message: 'no window.__timelines' },
              ],
            }) + '\n'
          cb(null, { stdout, stderr: '' })
        })
      },
    }))
  })

  it('parses the JSON even when hyperframes prints a telemetry banner first', async () => {
    const { runLint } = await import('../lint-runner.js')
    const result = await runLint({ projectDir: '/tmp/test-proj' })
    expect(result.errorCount).toBe(1)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].rule).toBe('missing_timeline_registry')
  })
})
