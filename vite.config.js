import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'node:fs'
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

export default defineConfig({
  define: {
    '__APP_VERSION__': JSON.stringify(gitSha),
    '__EXTENSION_ID__': JSON.stringify(getExtensionId()),
  },
  plugins: [react(), tailwindcss()],
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
