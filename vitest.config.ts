import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      exclude: ['tests/**'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
})
