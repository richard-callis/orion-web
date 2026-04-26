import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  try {
    // Login
    console.log('Logging in...')
    await page.goto(`${BASE}/login`)
    await page.locator('input').first().fill('testuser')
    await page.locator('input[type="password"]').first().fill('testpass')
    await page.locator('button:has-text("Sign in")').click()
    await page.waitForTimeout(1500)

    // Test storage endpoint
    console.log('\n=== Storage Endpoint ===')
    const storageResult = await page.evaluate(async () => {
      const r = await fetch('/api/environments/cmnv459540000zwkgwhyh5c3r/storage', { credentials: 'include' })
      return {
        status: r.status,
        data: await r.json()
      }
    })
    console.log(`Status: ${storageResult.status}`)
    console.log(`Response:`, JSON.stringify(storageResult.data, null, 2))

    // Test secrets endpoint
    console.log('\n=== Secrets Endpoint ===')
    const secretsResult = await page.evaluate(async () => {
      const r = await fetch('/api/environments/cmnv459540000zwkgwhyh5c3r/secrets', { credentials: 'include' })
      return {
        status: r.status,
        data: await r.json()
      }
    })
    console.log(`Status: ${secretsResult.status}`)
    console.log(`Response:`, JSON.stringify(secretsResult.data, null, 2))

  } finally {
    await browser.close()
  }
}

run().catch(e => { console.error(e); process.exit(1) })
