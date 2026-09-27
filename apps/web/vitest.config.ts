import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      // Never let tests reach a real Redis (the lib defaults to localhost:6379,
      // which on a dev/prod host is the live instance). Opt in with REDIS_TEST_URL.
      REDIS_URL: process.env.REDIS_TEST_URL ?? 'redis://127.0.0.1:1/0',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
