// Playwright test runner config for ORION end-to-end specs.
//   npx playwright install chromium   # once
//   ORION_E2E_USER=… ORION_E2E_PASSWORD=… npm run test:e2e
import { defineConfig } from '@playwright/test'
import { BASE } from './env.mjs'

export default defineConfig({
  testDir: './specs',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  outputDir: './test-results',
  use: {
    baseURL: BASE,
    headless: true,
    trace: 'retain-on-failure',
  },
})
