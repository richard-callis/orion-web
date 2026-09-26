// Minimal smoke coverage ported from the ad-hoc scripts in e2e/scripts/.
import { test, expect } from '@playwright/test'
import { HAS_CREDENTIALS, USER, PASSWORD } from '../env.mjs'

test('health endpoint responds', async ({ request }) => {
  const res = await request.get('/api/health')
  expect(res.ok()).toBeTruthy()
})

test('login page renders with a CSP nonce', async ({ page }) => {
  const res = await page.goto('/login')
  expect(res?.status()).toBeLessThan(400)
  const csp = res?.headers()['content-security-policy'] ?? ''
  expect(csp).toContain('nonce-')
  await expect(page.locator('input[type="password"]').first()).toBeVisible()
})

test.describe('authenticated', () => {
  test.skip(!HAS_CREDENTIALS, 'set ORION_E2E_USER / ORION_E2E_PASSWORD')

  test('can sign in and open infrastructure without CSP violations', async ({ page }) => {
    const cspErrors = []
    page.on('console', msg => {
      if (msg.type() === 'error' && msg.text().includes('Content Security Policy')) cspErrors.push(msg.text())
    })
    await page.goto('/login')
    await page.locator('input').first().fill(USER)
    await page.locator('input[type="password"]').first().fill(PASSWORD)
    await page.locator('button:has-text("Sign in")').click()
    await page.waitForURL(url => !url.pathname.startsWith('/login'))
    const res = await page.goto('/infrastructure')
    expect(res?.status()).toBeLessThan(400)
    expect(cspErrors).toEqual([])
  })
})
