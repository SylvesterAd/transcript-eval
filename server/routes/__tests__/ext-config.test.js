// server/routes/__tests__/ext-config.test.js
//
// Tests for the fps_probe_enabled field in getExtConfig().
// ext-config.js is a pure service (no DB, no HTTP) — tested directly
// without supertest (matching the project convention for this test dir).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getExtConfig, parseBool } from '../../services/ext-config.js'

describe('GET /api/ext-config — fps_probe_enabled', () => {
  const ORIG = process.env.EXT_FPS_PROBE_ENABLED

  afterEach(() => {
    if (ORIG === undefined) {
      delete process.env.EXT_FPS_PROBE_ENABLED
    } else {
      process.env.EXT_FPS_PROBE_ENABLED = ORIG
    }
  })

  it('includes fps_probe_enabled in the response', () => {
    delete process.env.EXT_FPS_PROBE_ENABLED
    const cfg = getExtConfig()
    expect(cfg).toHaveProperty('fps_probe_enabled')
    expect(typeof cfg.fps_probe_enabled).toBe('boolean')
  })

  it('defaults fps_probe_enabled to true when env var is unset', () => {
    delete process.env.EXT_FPS_PROBE_ENABLED
    const cfg = getExtConfig()
    expect(cfg.fps_probe_enabled).toBe(true)
  })

  it('defaults fps_probe_enabled to true when env var is empty string', () => {
    process.env.EXT_FPS_PROBE_ENABLED = ''
    const cfg = getExtConfig()
    expect(cfg.fps_probe_enabled).toBe(true)
  })

  it('returns false when EXT_FPS_PROBE_ENABLED=false', () => {
    process.env.EXT_FPS_PROBE_ENABLED = 'false'
    const cfg = getExtConfig()
    expect(cfg.fps_probe_enabled).toBe(false)
  })

  it('returns false when EXT_FPS_PROBE_ENABLED=0', () => {
    process.env.EXT_FPS_PROBE_ENABLED = '0'
    const cfg = getExtConfig()
    expect(cfg.fps_probe_enabled).toBe(false)
  })

  it('returns true when EXT_FPS_PROBE_ENABLED=true', () => {
    process.env.EXT_FPS_PROBE_ENABLED = 'true'
    const cfg = getExtConfig()
    expect(cfg.fps_probe_enabled).toBe(true)
  })

  it('returns true when EXT_FPS_PROBE_ENABLED=1', () => {
    process.env.EXT_FPS_PROBE_ENABLED = '1'
    const cfg = getExtConfig()
    expect(cfg.fps_probe_enabled).toBe(true)
  })
})
