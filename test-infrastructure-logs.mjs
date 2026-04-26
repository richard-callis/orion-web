import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  const logs = []
  const errors = []

  page.on('console', msg => {
    const text = msg.text()
    logs.push(text)
    if (msg.type() === 'error') {
      errors.push(text)
    }
  })

  try {
    // Login
    console.log('Logging in...')
    await page.goto(`${BASE}/login`)
    await page.locator('input').first().fill('testuser')
    await page.locator('input[type="password"]').first().fill('testpass')
    await page.locator('button:has-text("Sign in")').click()
    await page.waitForTimeout(1500)

    // Navigate to infrastructure
    console.log('Loading infrastructure page...')
    await page.goto(`${BASE}/infrastructure`)
    await page.waitForTimeout(2000)

    // Print all logs
    console.log('\n=== Console Output ===')
    for (const log of logs) {
      if (log.includes('InfrastructureTabs') || log.includes('infrastructure')) {
        console.log(log)
      }
    }

    // Print errors
    if (errors.length > 0) {
      console.log('\n=== Errors ===')
      for (const err of errors) {
        console.log(`ERROR: ${err}`)
      }
    }

    // Check dropdown content
    console.log('\n=== Dropdown Content ===')
    const selectOptions = await page.locator('select option').all()
    console.log(`Options count: ${selectOptions.length}`)
    for (let i = 0; i < selectOptions.length; i++) {
      const text = await selectOptions[i].textContent()
      const value = await selectOptions[i].getAttribute('value')
      console.log(`  [${i}] value="${value}" text="${text}"`)
    }

  } finally {
    await browser.close()
  }
}

run().catch(e => { console.error(e); process.exit(1) })
