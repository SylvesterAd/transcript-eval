import { describe, it, expect, vi } from 'vitest'

// broll.js does top-level db work at import — same mock pattern as
// broll-extract-json.test.js so module load doesn't blow up without DATABASE_URL.
vi.mock('../../db.js', () => ({
  default: {
    prepare: vi.fn(() => ({
      run: vi.fn().mockResolvedValue({ changes: 0 }),
      get: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue([]),
    })),
  },
}))

import {
  __test__classifyYtDlpError as classifyYtDlpError,
  __test__isProxyRetryable as isProxyRetryable,
  __test__ytDlpRunWithRetries as ytDlpRunWithRetries,
  __test__ytDlpRunWithDatacenterRetry as ytDlpRunWithDatacenterRetry,
} from '../broll.js'

describe('classifyYtDlpError', () => {
  it('classifies a YouTube bot/sign-in challenge as bot_block', () => {
    expect(classifyYtDlpError("ERROR: [youtube] xyz: Sign in to confirm you're not a bot. Use --cookies-from-browser"))
      .toBe('bot_block')
  })

  it('classifies HTTP 429 as rate_limit', () => {
    expect(classifyYtDlpError('ERROR: HTTP Error 429: Too Many Requests')).toBe('rate_limit')
  })

  it('classifies connection reset as network', () => {
    expect(classifyYtDlpError('read ECONNRESET')).toBe('network')
    expect(classifyYtDlpError('Connection timed out')).toBe('network')
    expect(classifyYtDlpError('HTTP Error 503: Service Unavailable')).toBe('network')
  })

  it('classifies DRM-protected video as drm (and NOT as bot_block even if both phrases present)', () => {
    // DRM check runs before bot_block — verify ordering.
    expect(classifyYtDlpError('ERROR: This video is DRM protected'))
      .toBe('drm')
    expect(classifyYtDlpError('ERROR: This video is DRM protected. Sign in to confirm.'))
      .toBe('drm')
  })

  it('classifies private/removed videos as unavailable', () => {
    expect(classifyYtDlpError('ERROR: Private video. Sign in if you have been granted access.')).toBe('unavailable')
    expect(classifyYtDlpError('ERROR: Video unavailable')).toBe('unavailable')
    expect(classifyYtDlpError('ERROR: This video has been removed by the uploader')).toBe('unavailable')
  })

  it('classifies geo-blocked videos as geo_block', () => {
    expect(classifyYtDlpError('ERROR: This content is not available in your country')).toBe('geo_block')
  })

  it('falls back to "unknown" when nothing matches', () => {
    expect(classifyYtDlpError('Some unexpected yt-dlp output')).toBe('unknown')
  })

  it('handles empty/null/undefined stderr', () => {
    expect(classifyYtDlpError('')).toBe('unknown')
    expect(classifyYtDlpError(null)).toBe('unknown')
    expect(classifyYtDlpError(undefined)).toBe('unknown')
  })
})

describe('isProxyRetryable', () => {
  it('is true for IP-fixable errors', () => {
    for (const c of ['bot_block', 'rate_limit', 'network', 'geo_block', 'unknown']) {
      expect(isProxyRetryable(c)).toBe(true)
    }
  })

  it('is false for server-side / unrecoverable errors', () => {
    expect(isProxyRetryable('drm')).toBe(false)
    expect(isProxyRetryable('unavailable')).toBe(false)
  })
})

describe('ytDlpRunWithRetries', () => {
  function err(stderrText) {
    const e = new Error('yt-dlp failed')
    e.stderr = stderrText
    return e
  }
  const botBlockErr = () => err("ERROR: Sign in to confirm you're not a bot")
  const drmErr = () => err('ERROR: This video is DRM protected')
  const networkErr = () => err('read ECONNRESET')

  // Sleep is faked so 5 s + 10 s + 15 s of waits don't actually delay tests.
  const fakeSleep = vi.fn(async () => {})
  // Proxy builder echoes the sessId so the test can verify rotation.
  const fakeProxy = vi.fn((sessId) =>
    sessId
      ? `http://customer-x-cc-US-sessid-${sessId}:p@h`
      : `http://customer-x-cc-US:p@h`,
  )

  it('does not call the runner when no proxy is configured', async () => {
    const noProxy = vi.fn(() => null)
    const runner = vi.fn()
    await expect(
      ytDlpRunWithRetries(botBlockErr(), ['--dump-json', 'url'], {}, { runner, sleep: fakeSleep, buildProxy: noProxy }),
    ).rejects.toThrow('yt-dlp failed')
    expect(runner).not.toHaveBeenCalled()
  })

  it('does not retry on DRM error (server-side, no IP can fix)', async () => {
    const runner = vi.fn()
    await expect(
      ytDlpRunWithRetries(drmErr(), [], {}, { runner, sleep: fakeSleep, buildProxy: fakeProxy }),
    ).rejects.toThrow('yt-dlp failed')
    expect(runner).not.toHaveBeenCalled()
  })

  it('does not retry on unavailable (private/removed) videos', async () => {
    const runner = vi.fn()
    const unavailableErr = err('ERROR: Private video. Sign in if you have been granted access.')
    await expect(
      ytDlpRunWithRetries(unavailableErr, [], {}, { runner, sleep: fakeSleep, buildProxy: fakeProxy }),
    ).rejects.toThrow()
    expect(runner).not.toHaveBeenCalled()
  })

  it('retries up to 3 times on bot_block then succeeds on the 3rd', async () => {
    fakeSleep.mockClear()
    const runner = vi.fn()
      .mockRejectedValueOnce(botBlockErr())
      .mockRejectedValueOnce(botBlockErr())
      .mockResolvedValueOnce({ stdout: 'OK', stderr: '' })
    const result = await ytDlpRunWithRetries(botBlockErr(), [], {}, {
      runner, sleep: fakeSleep, buildProxy: fakeProxy,
    })
    expect(result).toEqual({ stdout: 'OK', stderr: '' })
    expect(runner).toHaveBeenCalledTimes(3)
    // Each attempt is preceded by a rotation wait — 5s, 10s, 15s.
    expect(fakeSleep.mock.calls.map(c => c[0])).toEqual([5000, 10000, 15000])
  })

  it('exhausts all 3 proxy attempts and throws when every attempt fails', async () => {
    const runner = vi.fn().mockRejectedValue(botBlockErr())
    await expect(
      ytDlpRunWithRetries(botBlockErr(), [], {}, { runner, sleep: fakeSleep, buildProxy: fakeProxy }),
    ).rejects.toThrow()
    expect(runner).toHaveBeenCalledTimes(3)
  })

  it('uses a different sessId on each proxy attempt (forces fresh exit IP)', async () => {
    fakeProxy.mockClear()
    const runner = vi.fn().mockRejectedValue(botBlockErr())
    try {
      await ytDlpRunWithRetries(botBlockErr(), [], {}, { runner, sleep: fakeSleep, buildProxy: fakeProxy })
    } catch { /* expected */ }
    // Probe call (null sessId) + 3 attempts (non-null sessIds).
    expect(fakeProxy).toHaveBeenCalledTimes(4)
    expect(fakeProxy.mock.calls[0][0]).toBeNull()
    const sessIds = [
      fakeProxy.mock.calls[1][0],
      fakeProxy.mock.calls[2][0],
      fakeProxy.mock.calls[3][0],
    ]
    expect(sessIds.every(s => typeof s === 'string' && s.length > 0)).toBe(true)
    expect(new Set(sessIds).size).toBe(3) // all unique
  })

  it('classifies network errors as retryable', async () => {
    const runner = vi.fn()
      .mockRejectedValueOnce(networkErr())
      .mockResolvedValueOnce({ stdout: 'OK', stderr: '' })
    const result = await ytDlpRunWithRetries(networkErr(), [], {}, {
      runner, sleep: fakeSleep, buildProxy: fakeProxy,
    })
    expect(result.stdout).toBe('OK')
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('stops early if a mid-loop error becomes non-retryable (e.g. DRM revealed after geo unblock)', async () => {
    // First attempt: still a network error (retryable).
    // Second attempt: proxy got past geo-block, but the video is actually DRM-protected.
    // Expected: bail after the second attempt — don't burn the third.
    const runner = vi.fn()
      .mockRejectedValueOnce(networkErr())
      .mockRejectedValueOnce(drmErr())
    await expect(
      ytDlpRunWithRetries(botBlockErr(), [], {}, { runner, sleep: fakeSleep, buildProxy: fakeProxy }),
    ).rejects.toThrow()
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('passes the proxied URL through as a "--proxy <url>" prefix', async () => {
    const runner = vi.fn().mockResolvedValueOnce({ stdout: 'OK', stderr: '' })
    await ytDlpRunWithRetries(botBlockErr(), ['--dump-json', 'http://x'], { timeout: 1000 }, {
      runner, sleep: fakeSleep, buildProxy: fakeProxy,
    })
    const [args, options] = runner.mock.calls[0]
    expect(args[0]).toBe('--proxy')
    expect(args[1]).toMatch(/^http:\/\/customer-x-cc-US-sessid-/)
    expect(args.slice(2)).toEqual(['--dump-json', 'http://x'])
    expect(options).toEqual({ timeout: 1000 })
  })
})

describe('ytDlpRunWithDatacenterRetry', () => {
  function err(stderrText) {
    const e = new Error('yt-dlp failed')
    e.stderr = stderrText
    return e
  }
  const botBlockErr = () => err("ERROR: Sign in to confirm you're not a bot")
  const drmErr = () => err('ERROR: This video is DRM protected')
  const networkErr = () => err('read ECONNRESET')
  const unavailableErr = () => err('ERROR: Private video')

  const fakeSleep = vi.fn(async () => {})

  it('fails fast on DRM error without retrying datacenter or proxy', async () => {
    const runner = vi.fn()
    const proxyRetry = vi.fn()
    await expect(ytDlpRunWithDatacenterRetry(drmErr(), [], {}, { runner, sleep: fakeSleep, proxyRetry }))
      .rejects.toThrow()
    expect(runner).not.toHaveBeenCalled()
    expect(proxyRetry).not.toHaveBeenCalled()
  })

  it('fails fast on unavailable error', async () => {
    const runner = vi.fn()
    const proxyRetry = vi.fn()
    await expect(ytDlpRunWithDatacenterRetry(unavailableErr(), [], {}, { runner, sleep: fakeSleep, proxyRetry }))
      .rejects.toThrow()
    expect(runner).not.toHaveBeenCalled()
    expect(proxyRetry).not.toHaveBeenCalled()
  })

  it('retries datacenter once on network error and succeeds', async () => {
    fakeSleep.mockClear()
    const runner = vi.fn().mockResolvedValueOnce({ stdout: 'OK', stderr: '' })
    const proxyRetry = vi.fn()
    const result = await ytDlpRunWithDatacenterRetry(networkErr(), [], {}, { runner, sleep: fakeSleep, proxyRetry })
    expect(result.stdout).toBe('OK')
    expect(runner).toHaveBeenCalledTimes(1) // one retry
    expect(proxyRetry).not.toHaveBeenCalled()
    expect(fakeSleep).toHaveBeenCalledWith(3000)
  })

  it('retries datacenter once on bot_block and succeeds (lucky retry)', async () => {
    const runner = vi.fn().mockResolvedValueOnce({ stdout: 'OK', stderr: '' })
    const proxyRetry = vi.fn()
    const result = await ytDlpRunWithDatacenterRetry(botBlockErr(), [], {}, { runner, sleep: fakeSleep, proxyRetry })
    expect(result.stdout).toBe('OK')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(proxyRetry).not.toHaveBeenCalled()
  })

  it('falls through to proxyRetry when datacenter retry also fails', async () => {
    const runner = vi.fn().mockRejectedValueOnce(networkErr())
    const proxyRetry = vi.fn().mockResolvedValueOnce({ stdout: 'PROXY_OK', stderr: '' })
    const result = await ytDlpRunWithDatacenterRetry(networkErr(), [], {}, { runner, sleep: fakeSleep, proxyRetry })
    expect(result.stdout).toBe('PROXY_OK')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(proxyRetry).toHaveBeenCalledTimes(1)
    // proxyRetry called with the second-attempt error, not the initial one
    expect(proxyRetry.mock.calls[0][0].stderr).toBe('read ECONNRESET')
  })

  it('hands the LATEST error (not the initial one) to proxyRetry', async () => {
    const initialErr = err('ECONNRESET initial')
    const secondErr = err('HTTP Error 429 second')
    const runner = vi.fn().mockRejectedValueOnce(secondErr)
    const proxyRetry = vi.fn().mockResolvedValueOnce({ stdout: 'OK', stderr: '' })
    await ytDlpRunWithDatacenterRetry(initialErr, [], {}, { runner, sleep: fakeSleep, proxyRetry })
    expect(proxyRetry.mock.calls[0][0]).toBe(secondErr)
  })
})
