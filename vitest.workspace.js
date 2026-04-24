// Vitest workspace — dual-environment fan-out.
//   - server: Node 20 env, server/**/__tests__/**/*.test.js (XMEML
//             generator tests + new exports service tests).
//   - web:    happy-dom env, src/**/__tests__/**/*.test.{js,jsx}
//             (State E XMEML hook tests).
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
    // JSX component tests (e.g. StateF_Partial.test.jsx) need JSX to
    // transform via the automatic runtime — otherwise esbuild emits
    // React.createElement(...) calls and components without a top-
    // level `import React` throw "React is not defined" at render
    // time. vitest 1.6.x doesn't inherit the vite.config.js react
    // plugin into workspace projects; esbuild.jsx settings here do
    // the same job without the plugin dep.
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
