// Vitest workspace — triple-environment fan-out.
//   - server:    Node 20 env, server/**/__tests__/**/*.test.js (XMEML
//                generator tests + exports service tests).
//   - web:       happy-dom env, src/**/__tests__/**/*.test.{js,jsx}
//                (State E XMEML hook tests + WebApp.3/State F).
//   - extension: Node 20 env, extension/**/__tests__/**/*.test.js
//                (Ext.8 diagnostics — mocks chrome.* globals so node
//                env is sufficient).
//
// Vitest 1.6.x uses this file (a workspace file) instead of an
// inline `projects:` key on defineConfig (which is 2.x syntax).
//
// Each entry is a vitest config object — only the test-specific
// keys are required; vitest merges with the defaults from
// vitest.config.js.

import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  {
    test: {
      name: 'server',
      environment: 'node',
      include: ['server/**/__tests__/**/*.test.js'],
      globals: false,
    },
  },
  {
    test: {
      name: 'extension',
      environment: 'node',
      include: ['extension/**/__tests__/**/*.test.js'],
      globals: false,
    },
  },
  {
    // JSX component tests (ExportsList/ExportDetail from WebApp.3,
    // StateF_Partial from State F) need the automatic JSX runtime —
    // otherwise esbuild emits React.createElement(...) calls and
    // components without a top-level `import React` throw
    // "React is not defined" at render time. vitest 1.6.x does NOT
    // inherit the vite.config.js @vitejs/plugin-react plugin into
    // workspace projects, so we configure esbuild here directly
    // (matches vite.config.js automatic-runtime behavior without the
    // plugin dep).
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'react',
    },
    test: {
      name: 'web',
      environment: 'happy-dom',
      include: [
        'src/**/__tests__/**/*.test.js',
        'src/**/__tests__/**/*.test.jsx',
      ],
      globals: false,
    },
  },
])
