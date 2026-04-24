// extension/scripts/__tests__/package.test.js
//
// Ext.10 — verifies the reproducible packager (extension/scripts/package.mjs).
// Shells out to the script via spawnSync with --out <tmpdir> so tests are
// insulated from the real extension/dist directory.
//
// The exclude coverage is the load-bearing test — a future developer adding
// a debug file to extension/ will fail this suite unless they also update
// ROOT_INCLUDES / DIR_INCLUDES in package.mjs. Fail-closed, not fail-open.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(TEST_DIR, '..', '..', '..') // extension/scripts/__tests__/ -> repo root
const SCRIPT = join(REPO_ROOT, 'extension', 'scripts', 'package.mjs')
const EXT_ROOT = join(REPO_ROOT, 'extension')

function runPackager(args) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
}

function manifestVersion() {
  const m = JSON.parse(readFileSync(join(EXT_ROOT, 'manifest.json'), 'utf8'))
  return m.version
}

describe('package.mjs', () => {
  let tmpOut

  beforeEach(() => {
    tmpOut = mkdtempSync(join(tmpdir(), 'ext-pkg-'))
  })

  afterEach(() => {
    rmSync(tmpOut, { recursive: true, force: true })
  })

  it('exits 0 with --help and prints usage', () => {
    const res = runPackager(['--help'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('--out')
    expect(res.stdout).toContain('--no-zip')
    expect(res.stdout).toContain('--verbose')
  })

  it('stages manifest + SW + popup + modules into --out on --no-zip', () => {
    const res = runPackager(['--no-zip', '--out', tmpOut])
    expect(res.status, `stderr: ${res.stderr}\nstdout: ${res.stdout}`).toBe(0)
    // Root includes.
    expect(existsSync(join(tmpOut, 'manifest.json'))).toBe(true)
    expect(existsSync(join(tmpOut, 'service_worker.js'))).toBe(true)
    expect(existsSync(join(tmpOut, 'popup.html'))).toBe(true)
    expect(existsSync(join(tmpOut, 'popup.css'))).toBe(true)
    expect(existsSync(join(tmpOut, 'popup.js'))).toBe(true)
    expect(existsSync(join(tmpOut, 'config.js'))).toBe(true)
    // Module includes.
    expect(existsSync(join(tmpOut, 'modules', 'auth.js'))).toBe(true)
    expect(existsSync(join(tmpOut, 'modules', 'config-fetch.js'))).toBe(true)
    expect(existsSync(join(tmpOut, 'modules', 'diagnostics.js'))).toBe(true)
    expect(existsSync(join(tmpOut, 'modules', 'queue.js'))).toBe(true)
    expect(existsSync(join(tmpOut, 'modules', 'telemetry.js'))).toBe(true)
  })

  it('excludes __tests__/, .extension-id, README.md, scripts/, generate-key.mjs', () => {
    const res = runPackager(['--no-zip', '--out', tmpOut])
    expect(res.status).toBe(0)
    expect(existsSync(join(tmpOut, '.extension-id'))).toBe(false)
    expect(existsSync(join(tmpOut, 'README.md'))).toBe(false)
    expect(existsSync(join(tmpOut, 'scripts'))).toBe(false)
    expect(existsSync(join(tmpOut, 'modules', '__tests__'))).toBe(false)
    // A representative test file from Ext.8 / Ext.9 — must not ship.
    expect(existsSync(join(tmpOut, 'modules', '__tests__', 'diagnostics.test.js'))).toBe(false)
    expect(existsSync(join(tmpOut, 'modules', '__tests__', 'config-fetch.test.js'))).toBe(false)
    // generate-key.mjs is the developer-only Ext.1 keygen — must not ship.
    expect(existsSync(join(tmpOut, 'generate-key.mjs'))).toBe(false)
  })

  it('produces a zip at extension-${version}.zip with default flags', () => {
    const res = runPackager(['--out', tmpOut])
    expect(res.status, `stderr: ${res.stderr}`).toBe(0)
    const version = manifestVersion()
    const zipPath = join(tmpOut, `extension-${version}.zip`)
    expect(existsSync(zipPath)).toBe(true)
    const bytes = readFileSync(zipPath)
    expect(bytes.length).toBeGreaterThan(1000) // non-empty, non-trivial
    // sha256 from script output must match on-disk bytes.
    const sha = createHash('sha256').update(bytes).digest('hex')
    expect(res.stdout).toContain(sha)
  })

  it('is deterministic — two runs produce byte-identical zips', () => {
    const tmpOut2 = mkdtempSync(join(tmpdir(), 'ext-pkg-'))
    try {
      const r1 = runPackager(['--out', tmpOut])
      const r2 = runPackager(['--out', tmpOut2])
      expect(r1.status).toBe(0)
      expect(r2.status).toBe(0)
      const version = manifestVersion()
      const bytes1 = readFileSync(join(tmpOut, `extension-${version}.zip`))
      const bytes2 = readFileSync(join(tmpOut2, `extension-${version}.zip`))
      const sha1 = createHash('sha256').update(bytes1).digest('hex')
      const sha2 = createHash('sha256').update(bytes2).digest('hex')
      expect(sha1).toBe(sha2)
    } finally {
      rmSync(tmpOut2, { recursive: true, force: true })
    }
  })

  it('rejects unknown flags with exit 2', () => {
    const res = runPackager(['--bogus'])
    expect(res.status).toBe(2)
    expect(res.stderr).toContain('Unknown flag')
  })
})
