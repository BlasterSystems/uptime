import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Views and layouts are exercised end-to-end (e2e/); the unit layer owns
      // the logic modules and the reusable components. Thresholds pin the
      // current baseline (render-only components keep function counts low).
      // Vitest 4's ast-aware v8 remapper counts uncovered functions inside
      // never-mounted SFCs that the vitest 3 remapper silently skipped, so
      // the baseline was re-pinned to the vitest 4 truth (29/29/19).
      include: ['src/**/*.ts', 'src/components/**/*.{ts,vue}'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      thresholds: { lines: 29, statements: 29, functions: 19 },
    },
  },
})
