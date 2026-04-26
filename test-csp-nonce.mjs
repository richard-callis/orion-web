import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  const cspErrors = []
  const allErrors = []

  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text()
      allErrors.push(text)
      if (text.includes('Content Security Policy')) cspErrors.push(text)
    }
  })

  try {
    // Login
    await page.goto(`${BASE}/login`)
    await page.locator('input').first().fill('testuser')
    await page.locator('input[type="password"]').first().fill('testpass')
    await page.locator('button:has-text("Sign in")').click()
    await page.waitForTimeout(1500)

    // Navigate through pages that load JS
    const pages = ['/infrastructure', '/agents', '/chat', '/notes']
    for (const p of pages) {
      await page.goto(`${BASE}${p}`)
      await page.waitForTimeout(1000)
    }

    // Check CSP header
    const response = await page.goto(`${BASE}/infrastructure`)
    const cspHeader = response?.headers()['content-security-policy'] ?? ''

    console.log('=== CSP Header ===')
    console.log(cspHeader)
    console.log()

    const hasNonce = /nonce-[A-Za-z0-9+/=]+/.test(cspHeader)
    const hasStrictDynamic = cspHeader.includes('strict-dynamic')
    const hasUnsafeInline = cspHeader.includes('unsafe-inline')

    console.log('=== CSP Analysis ===')
    console.log(`  Has nonce:          ${hasNonce ? '✓ YES' : '✗ NO'}`)
    console.log(`  Has strict-dynamic: ${hasStrictDynamic ? '✓ YES' : '✗ NO'}`)
    console.log(`  Has unsafe-inline:  ${hasUnsafeInline ? '✗ YES (bad)' : '✓ NO (good)'}`)
    console.log()

    console.log('=== CSP Errors ===')
    if (cspErrors.length === 0) {
      console.log('  ✓ ZERO CSP violations detected')
    } else {
      console.log(`  ✗ ${cspErrors.length} CSP violations:`)
      cspErrors.forEach(e => console.log(`    - ${e.slice(0, 120)}`))
    }

    console.log()
    console.log('=== SOC II Compliance ===')
    const compliant = hasNonce && hasStrictDynamic && !hasUnsafeInline && cspErrors.length === 0
    console.log(compliant
      ? '  ✓ PASS — Nonce-based CSP with strict-dynamic, no unsafe-inline'
      : '  ✗ FAIL — See issues above')

    if (allErrors.length > 0 && cspErrors.length === 0) {
      console.log(`\n=== Other Errors (non-CSP) ===`)
      allErrors.forEach(e => console.log(`  - ${e.slice(0, 120)}`))
    }

    process.exit(compliant ? 0 : 1)
  } finally {
    await browser.close()
  }
}

run().catch(e => { console.error(e); process.exit(1) })
