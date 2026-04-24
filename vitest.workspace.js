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
