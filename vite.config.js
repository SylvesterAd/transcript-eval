import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'unknown' } })()

// Extension ID: pinned by Ext.1 in extension/.extension-id (committed).
// Override via VITE_EXTENSION_ID env var when the file isn't present
// (e.g. building before Ext.1 has merged to main, or pointing the
// dev build at a freshly-loaded unpacked extension whose ID differs).
function getExtensionId() {
  const fromEnv = process.env.VITE_EXTENSION_ID
  if (fromEnv) return fromEnv
  const fromFile = path.resolve(__dirname, 'extension/.extension-id')
  if (existsSync(fromFile)) return readFileSync(fromFile, 'utf-8').trim()
  // Don't throw — let the bundle build with a sentinel so the dev test
  // page can render an actionable error instead of a build failure.
  return ''
}

// Latest extension version, read from extension/manifest.json at build
// time. The web app uses this to detect installed-but-outdated
// extensions and prompt the user to update (StateA_Install). Empty
// string means "unknown" — the web app will skip the outdated check.
function getExtLatestVersion() {
  const fromEnv = process.env.VITE_EXT_LATEST_VERSION
  if (fromEnv) return fromEnv
  const fromFile = path.resolve(__dirname, 'extension/manifest.json')
  if (existsSync(fromFile)) {
    try { return JSON.parse(readFileSync(fromFile, 'utf-8')).version || '' } catch { return '' }
  }
  return ''
}

// Chrome derives an unpacked extension's ID from the public key in the
// manifest's `key` field via the same SHA-256 → 0-9a-f → a-p mapping
// used here. The Web Store assigns a *different* key on first publish,
// so the source-tree dev ID and the published ID are intentionally
// different (see commit f90edc6). We bake both so the production web
// app can probe the dev-loaded extension too — first hit wins in
// useExtension.ping().
function computeExtIdFromManifestKey(keyB64) {
  try {
    const sha = createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest()
    let id = ''
    for (let i = 0; i < 16; i++) {
      id += String.fromCharCode(97 + (sha[i] >> 4))
      id += String.fromCharCode(97 + (sha[i] & 0xf))
    }
    return id
  } catch { return '' }
}

function getExtensionIdFallbacks() {
  const fromEnv = process.env.VITE_EXTENSION_ID_FALLBACKS
  if (fromEnv) return fromEnv.split(',').map(s => s.trim()).filter(Boolean)
  const manifestPath = path.resolve(__dirname, 'extension/manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      if (m.key) {
        const id = computeExtIdFromManifestKey(m.key)
        return id ? [id] : []
      }
    } catch {}
  }
  return []
}

export default defineConfig({
  define: {
    '__APP_VERSION__': JSON.stringify(gitSha),
    '__EXTENSION_ID__': JSON.stringify(getExtensionId()),
    '__EXTENSION_ID_FALLBACKS__': JSON.stringify(getExtensionIdFallbacks()),
    '__EXT_LATEST_VERSION__': JSON.stringify(getExtLatestVersion()),
  },
  plugins: [react(), tailwindcss()],
  // extension-test.html is a dev-only harness — vite's default MPA
  // crawl would ship it in dist/. Restrict prod entries to index.html.
  build: {
    rollupOptions: {
      input: { main: 'index.html' }
    }
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        timeout: 3600000, // 1 hour for large file uploads + concat
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Remove content-length limit for file uploads
            proxyReq.setHeader('connection', 'keep-alive')
          })
        }
      },
      '/uploads': 'http://localhost:3001'
    },
    hmr: { overlay: false }
  }
})
