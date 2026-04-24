import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { execSync } from 'child_process'

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim() } catch { return 'unknown' } })()

export default defineConfig({
  define: { '__APP_VERSION__': JSON.stringify(gitSha) },
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
