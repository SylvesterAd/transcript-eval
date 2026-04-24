// Vitest config for transcript-eval. First test harness in the project
// — kept minimal. Tests live next to the code they test, under a
// __tests__/ directory, to match the server/services/__tests__/ pattern
// established by WebApp.2.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',        // server-side code; no DOM
    include: ['server/**/__tests__/**/*.test.js'],
    globals: false,             // explicit imports of describe/it/expect
    reporters: 'default',
    watch: false,               // `npm run test:watch` opts in
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['server/services/**/*.js'],
      exclude: ['server/services/__tests__/**', 'server/services/*.py'],
    },
  },
})
