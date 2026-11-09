import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      // Vitest 4's ast-aware v8 remapper counts uncovered functions the
      // vitest 3 remapper silently skipped; statements/functions re-pinned
      // to the vitest 4 baseline (74.74 / 71.92).
      thresholds: { lines: 75, functions: 71, statements: 74 },
    },
  },
})
