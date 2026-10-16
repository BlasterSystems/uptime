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
      include: ['src/**/*.ts', 'src/components/**/*.{ts,vue}'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      thresholds: { lines: 33, statements: 33, functions: 38 },
    },
  },
})
