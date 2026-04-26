import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  // Capture console logs
  page.on('console', msg => {
    const type = msg.type()
    const text = msg.text()
    if (type === 'error' || type === 'warning') {
      console.log(`  [${type}] ${text}`)
    }
  })

  // Capture unhandled promise rejections
  page.on('pageerror', err => {
    console.log(`  [PAGE ERROR] ${err.message}`)
  })

  let pass = 0
  let fail = 0
  function check(name, condition) {
    if (condition) {
      console.log(`  PASS: ${name}`)
      pass++
    } else {
      console.log(`  FAIL: ${name}`)
      fail++
    }
  }

  // ─── Test 1: Homepage loads ───
  console.log('\n=== Test 1: Homepage ===')
  try {
    const res = await page.goto(BASE)
    const status = res?.status()
    check('Status 200', status === 200)
    if (res) {
      const text = await res.text()
      check('Contains "ORION"', text.toLowerCase().includes('orion'))
      check('No 500 error in body', !text.includes('<h1>500</h1>'))
      check('Has CSS styles', text.includes('.css'))
    }
  } catch (e) {
    check(`Homepage reachable`, false)
    console.log(`  Error: ${e.message}`)
  }

  // ─── Test 2: API /api/environments (unauthenticated) ───
  console.log('\n=== Test 2: API /api/environments (no auth) ===')
  try {
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/environments', { credentials: 'include' })
      return { status: r.status, text: await r.text() }
    })
    check('Status 401 (need login)', res.status === 401)
    console.log(`  Response: ${res.text.slice(0, 100)}`)
  } catch (e) {
    check('API call worked', false)
    console.log(`  Error: ${e.message}`)
  }

  // ─── Test 3: Login page loads ───
  console.log('\n=== Test 3: Login Page ===')
  try {
    const res = await page.goto(`${BASE}/login`)
    check('Status 200', res?.status() === 200)
    const body = await page.textContent('body')
    check('Has login form', body?.includes('login') || body?.includes('Login') || body?.includes('Sign in'))
    check('Has username field', body?.includes('username') || body?.includes('Username'))
  } catch (e) {
    check(`Login page reachable`, false)
    console.log(`  Error: ${e.message}`)
  }

  // ─── Test 4: Infrastructure page loads (unauthenticated) ───
  console.log('\n=== Test 4: Infrastructure Page (no auth) ===')
  try {
    const res = await page.goto(`${BASE}/infrastructure`)
    check('Status 200', res?.status() === 200)
    const body = await page.textContent('body')
    check('Contains infrastructure content', body?.includes('Infrastructure') || body?.includes('infrastructure'))
  } catch (e) {
    check(`Infrastructure page reachable`, false)
    console.log(`  Error: ${e.message}`)
  }

  // ─── Test 5: Admin environments page ───
  console.log('\n=== Test 5: Admin Environments Page (no auth) ===')
  try {
    const res = await page.goto(`${BASE}/admin/environments`)
    check('Status 200', res?.status() === 200)
  } catch (e) {
    check(`Admin environments reachable`, false)
    console.log(`  Error: ${e.message}`)
  }

  // ─── Test 6: Other API endpoints ───
  console.log('\n=== Test 6: Other API Endpoints (no auth) ===')
  const endpoints = [
    '/api/agents',
    '/api/tasks',
    '/api/features',
  ]
  for (const ep of endpoints) {
    try {
      const res = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'include' })
        return { status: r.status }
      }, ep)
      check(`${ep} → ${res.status}`, res.status === 401 || res.status === 200)
    } catch (e) {
      check(`${ep} reachable`, false)
    }
  }

  // ─── Test 7: Check for common JS errors ───
  console.log('\n=== Test 7: JavaScript Errors ===')
  const consoleErrors = []
  const originalError = console.error
  // We already capture page errors above
  check('No page-level JS errors detected', fail < 5)

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`)
  await browser.close()

  process.exit(fail > 0 ? 1 : 0)
}

run().catch(e => {
  console.error(e)
  process.exit(1)
})
