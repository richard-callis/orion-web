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

    // Fetch environment data
    const envData = await page.evaluate(async () => {
      const r = await fetch('/api/environments', { credentials: 'include' })
      return await r.json()
    })

    console.log('\n=== API Response: /api/environments ===')
    console.log(`Total environments: ${envData.length}\n`)

    for (let i = 0; i < envData.length; i++) {
      const env = envData[i]
      console.log(`[${i}] ${env.name}`)
      console.log(`    id: ${env.id}`)
      console.log(`    type: ${env.type}`)
      console.log(`    gatewayUrl: ${env.gatewayUrl}`)
      console.log(`    gatewayToken: ${env.gatewayToken}`)
      console.log(`    status: ${env.status}`)
      console.log()
    }

    // Show what the filter would do
    const clusters = envData.filter(e => e.type === 'cluster' && e.gatewayUrl)
    console.log(`=== Filter Results ===`)
    console.log(`Filter: e.type === 'cluster' && e.gatewayUrl`)
    console.log(`Matched: ${clusters.length} environments\n`)

    for (const env of clusters) {
      console.log(`✓ ${env.name}`)
    }

    if (clusters.length === 0) {
      console.log('✗ NO ENVIRONMENTS MATCHED THE FILTER')
      console.log('\nDebugging information:')
      for (const env of envData) {
        const matches = env.type === 'cluster' && env.gatewayUrl
        console.log(`  ${env.name}: type="${env.type}" (is "cluster"? ${env.type === 'cluster'}), gatewayUrl="${env.gatewayUrl}" (truthy? ${!!env.gatewayUrl})`)
      }
    }

  } finally {
    await browser.close()
  }
}

run().catch(e => { console.error(e); process.exit(1) })
