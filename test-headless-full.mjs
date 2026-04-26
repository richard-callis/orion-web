import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  let consoleErrors = []
  let consoleWarnings = []
  let pageErrors = []

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
    if (msg.type() === 'warning') consoleWarnings.push(msg.text())
  })
  page.on('pageerror', err => {
    pageErrors.push(err.message)
  })

  let pass = 0
  let fail = 0
  function check(name, condition) {
    if (condition) { console.log(`  PASS: ${name}`); pass++ }
    else { console.log(`  FAIL: ${name}`); fail++ }
  }

  // ═══════════════════════════════════════════════
  // Test 1: Homepage
  // ═══════════════════════════════════════════════
  console.log('\n=== Test 1: Homepage ===')
  const hp = await page.goto(BASE)
  check('Status 200', hp?.status() === 200)
  const hpText = await page.textContent('body')
  check('Contains ORION', hpText?.toLowerCase().includes('orion'))
  check('No 500 error', !hpText?.includes('<h1>500</h1>'))

  // ═══════════════════════════════════════════════
  // Test 2: Login Page
  // ═══════════════════════════════════════════════
  console.log('\n=== Test 2: Login Page ===')
  const lp = await page.goto(`${BASE}/login`)
  check('Status 200', lp?.status() === 200)
  const lpBody = await page.textContent('body')
  check('Has sign in form', lpBody?.includes('Sign in'))

  // ═══════════════════════════════════════════════
  // Test 3: Login (using React state, no name attrs)
  // ═══════════════════════════════════════════════
  console.log('\n=== Test 3: Login ===')
  // The form uses onChange handlers, not name attrs
  // Fill by label or by input order
  const allInputs = await page.locator('input').all()
  // First input is username (type="text" or no type), second is password
  await page.locator('input').first().fill('admin')
  await page.locator('input[type="password"]').first().fill('admin')

  // Click sign in button
  const signInBtn = page.locator('button:has-text("Sign in")')
  if (await signInBtn.count() > 0) {
    await signInBtn.first().click()
    await page.waitForTimeout(3000)
  }

  const afterLoginUrl = page.url()
  console.log(`  URL after login: ${afterLoginUrl}`)
  const loggedOut = afterLoginUrl.includes('/login')
  const hasError = loggedOut && (await page.textContent('body'))?.includes('Invalid')
  if (loggedOut) {
    check('Login succeeded (redirected away from /login)', false)
    console.log('  Login failed - check credentials or server logs')
    // Log the error
    const body = await page.textContent('body')
    if (body?.includes('Invalid')) {
      console.log('  Error message: Invalid username or password')
    }
  } else {
    check('Login succeeded', true)
  }

  // ═══════════════════════════════════════════════
  // Test 4: API endpoints (with session cookies)
  // ═══════════════════════════════════════════════
  console.log('\n=== Test 4: API Endpoints ===')
  const apis = [
    '/api/environments',
    '/api/agents',
    '/api/tasks',
    '/api/features',
    '/api/setup',
  ]
  for (const ep of apis) {
    const result = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: 'include' })
      const text = await r.text()
      let data = null, isArray = false, len = 0
      try { data = JSON.parse(text); isArray = Array.isArray(data); len = isArray ? data.length : Object.keys(data).length } catch {}
      return {
        status: r.status,
        isJson: text.trim()[0] === '{' || text.trim()[0] === '[',
        isArray,
        len,
        textLen: text.length,
        first100: text.slice(0, 100),
      }
    }, ep)
    if (result.isJson) {
      check(`${ep} → ${result.status} (JSON${result.isArray ? ', array' : ''}, ${result.len})`, result.status === 200)
    } else {
      // Could be HTML redirect or unexpected response
      console.log(`  ${ep}: ${result.first100}`)
      check(`${ep} → ${result.status} (textLen=${result.textLen})`, false)
    }
  }

  // ═══════════════════════════════════════════════
  // Test 5: Infrastructure page
  // ═══════════════════════════════════════════════
  console.log('\n=== Test 5: Infrastructure Page ===')
  const ip = await page.goto(`${BASE}/infrastructure`)
  check('Status 200', ip?.status() === 200)
  const ipBody = await page.textContent('body')
  check('Has infrastructure content', ipBody?.includes('Infrastructure') || ipBody?.toLowerCase().includes('overview'))
  check('No 500 error', !ipBody?.includes('<h1>500</h1>'))

  // Check for dropdown/select element
  const selects = await page.locator('select').all()
  check(`Has select elements (${selects.length})`, selects.length > 0)

  // Check for environment-related text
  const hasEnvText = ipBody?.includes('Select environment') || ipBody?.includes('environment')
  check('Has environment selector text', hasEnvText)

  // ═══════════════════════════════════════════════
  // Test 6: Admin pages
  // ═══════════════════════════════════════════════
  console.log('\n=== Test 6: Admin Pages ===')
  for (const p of ['/admin/environments', '/admin/users']) {
    const res = await page.goto(`${BASE}${p}`)
    check(`${p} → ${res?.status()}`, res?.status() === 200)
    const body = await page.textContent('body')
    check(`${p} no 500`, !body?.includes('<h1>500</h1>'))
  }

  // ═══════════════════════════════════════════════
  // Test 7: Other pages
  // ═══════════════════════════════════════════════
  console.log('\n=== Test 7: Other Pages ===')
  const pages = ['/agents', '/settings', '/chat']
  for (const p of pages) {
    try {
      const res = await page.goto(`${BASE}${p}`)
      const status = res?.status()
      const body = await page.textContent('body')
      const has500 = body?.includes('<h1>500</h1>') || body?.includes('500 - Internal')
      check(`${p} → ${status} (no 500)`, status === 200 && !has500)
    } catch (e) {
      check(`${p} reachable`, false)
    }
  }

  // ═══════════════════════════════════════════════
  // Test 8: Console/JS errors
  // ═══════════════════════════════════════════════
  console.log('\n=== Test 8: Console/JS Errors ===')
  check(`No console errors (${consoleErrors.length})`, consoleErrors.length === 0)
  check(`No page errors (${pageErrors.length})`, pageErrors.length === 0)
  check(`No console warnings (${consoleWarnings.length})`, consoleWarnings.length === 0)

  if (consoleErrors.length > 0) {
    console.log('  Console errors:')
    for (const e of consoleErrors.slice(0, 5)) console.log(`    ${e}`)
  }
  if (pageErrors.length > 0) {
    console.log('  Page errors:')
    for (const e of pageErrors.slice(0, 5)) console.log(`    ${e}`)
  }

  // ═══════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════
  console.log(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===\n`)
  await browser.close()

  process.exit(fail > 0 ? 1 : 0)
}

run().catch(e => { console.error(e); process.exit(1) })
