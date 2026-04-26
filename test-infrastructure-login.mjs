import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  let pass = 0
  let fail = 0

  function check(name, condition) {
    if (condition) { console.log(`  ✓ ${name}`); pass++ }
    else { console.log(`  ✗ ${name}`); fail++ }
  }

  try {
    // Test 1: Go to login page
    console.log('\n=== Test 1: Login ===')
    await page.goto(`${BASE}/login`)

    // Fill credentials
    await page.locator('input').first().fill('testuser')
    await page.locator('input[type="password"]').first().fill('testpass')

    // Click sign in
    await page.locator('button:has-text("Sign in")').click()
    await page.waitForTimeout(2000)

    const urlAfterLogin = page.url()
    check('Logged in successfully', !urlAfterLogin.includes('/login'))
    console.log(`  URL: ${urlAfterLogin}`)

    // Test 2: Navigate to infrastructure page
    console.log('\n=== Test 2: Infrastructure Page ===')
    await page.goto(`${BASE}/infrastructure`)
    const infraBody = await page.textContent('body')
    check('Page loads', infraBody?.includes('Infrastructure') || infraBody?.includes('infrastructure'))

    // Test 3: Check if environment dropdown appears
    console.log('\n=== Test 3: Environment Selector ===')
    const selects = await page.locator('select').all()
    check(`Select dropdown exists (${selects.length})`, selects.length > 0)

    if (selects.length > 0) {
      const selectText = await selects[0].evaluate(el => el.innerHTML)
      check('Dropdown has options', selectText.includes('<option'))

      // Try to get the options
      const options = await page.locator('select option').all()
      check(`Has ${options.length} options`, options.length > 0)

      if (options.length > 1) { // More than just "Select environment..."
        check('Has cluster environments', true)
        for (let i = 0; i < Math.min(3, options.length); i++) {
          const optText = await options[i].textContent()
          console.log(`    Option ${i}: ${optText}`)
        }
      } else {
        check('Has cluster environments', false)
        console.log('  ERROR: No cluster environments found in dropdown')
        console.log('  Check: Are there cluster environments in the database?')
      }
    }

    // Test 4: Check for API errors in the page
    console.log('\n=== Test 4: Console Errors ===')
    const errors = []
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text())
      }
    })

    // Make a test API call
    const apiResult = await page.evaluate(async () => {
      const r = await fetch('/api/environments', { credentials: 'include' })
      const text = await r.text()
      let isJson = false
      let dataLength = 0
      try {
        const data = JSON.parse(text)
        isJson = true
        dataLength = Array.isArray(data) ? data.length : 0
      } catch {}
      return {
        status: r.status,
        isJson,
        length: dataLength,
        textLen: text.length,
      }
    })

    check(`API /api/environments returns 200`, apiResult.status === 200)
    check(`API response is JSON`, apiResult.isJson)
    if (apiResult.isJson) {
      console.log(`  Response contains ${apiResult.length} environments`)
    }

    console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===\n`)

  } catch (e) {
    console.error('Test error:', e.message)
    fail++
  } finally {
    await browser.close()
    process.exit(fail > 0 ? 1 : 0)
  }
}

run().catch(e => { console.error(e); process.exit(1) })
