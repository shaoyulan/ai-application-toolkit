import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.ts'],
      // cli.ts is a thin argv/stdout entrypoint exercised end-to-end, not in unit tests
      exclude: ['**/*.test.ts', '**/dist/**', '**/cli.ts'],
      reporter: ['text', 'text-summary'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85
      }
    }
  }
})
