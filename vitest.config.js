// Vitest config for transcript-eval. Dual-environment via workspace:
//   - Node project: server-side code (services, routes). No DOM.
//   - Browser project: React hooks + pure frontend utilities under
//     src/. Uses happy-dom for URL.createObjectURL + document globals.
//
// Both projects share `globals: false` so describe/it/expect are
// always explicit imports — keeps tests portable and greppable.
//
// Vitest 1.6.x uses the `vitest.workspace.js` file (this is the
// "shared defaults" config — workspace projects below override).

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    reporters: 'default',
    watch: false,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['server/services/**/*.js', 'src/hooks/**/*.js', 'src/lib/**/*.js'],
      exclude: [
        'server/services/__tests__/**',
        'server/services/*.py',
        'src/hooks/__tests__/**',
        'src/lib/__tests__/**',
      ],
    },
  },
})
