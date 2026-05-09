/**
 * orion-claude — persistent Claude Code sidecar for ORION
 *
 * All Claude Code SDK calls go through this service. The OAuth token
 * never leaves this container — ORION sends prompts here, we run them
 * with the SDK, and stream results back as NDJSON.
 *
 * Endpoints:
 *   GET  /health             — liveness probe
 *   GET  /auth/status        — credential validity + expiry
 *   POST /auth/login         — start claude login, return auth URL when available
 *   POST /auth/code          — send code to running login process via stdin
 *   GET  /auth/poll          — poll login output + status
 *   POST /auth/cancel        — kill any running login process
 *   POST /auth/credentials   — store pasted credentials directly
 *   POST /run                — execute a query(), stream SDK events as NDJSON
 *   POST /run/collect        — execute a query(), return full text as JSON (for summarizer/review)
 */

const http       = require('http')
const fs         = require('fs')
const path       = require('path')
const pty        = require('node-pty')
const { execFile } = require('child_process')

const PORT       = parseInt(process.env.PORT || '3100', 10)
const CLAUDE_HOME = process.env.CLAUDE_HOME || '/root/.claude'
const CREDS_PATH = path.join(CLAUDE_HOME, '.credentials.json')

// ── Login state ───────────────────────────────────────────────────────────────

let loginProc   = null   // child_process
let loginOutput = ''     // accumulated stdout+stderr
let loginStatus = 'idle' // idle | starting | waiting | completing | done | error

function resetLogin() {
  if (loginProc) { try { loginProc.kill() } catch {} }
  loginProc   = null
  loginOutput = ''
  loginStatus = 'idle'
}

// Strip ANSI escape sequences from PTY output for clean URL extraction
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
}

function extractUrl(text) {
  const m = text.match(/https:\/\/[^\s\n]+/)
  return m ? m[0] : null
}

// ── Claude CLI subprocess helper ──────────────────────────────────────────────

function sanitizeModel(model) {
  if (typeof model !== 'string') return null
  const trimmed = model.trim()
  // allow common model identifier characters only
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(trimmed)) return null
  return trimmed
}

function sanitizeSystemPrompt(systemPrompt) {
  if (typeof systemPrompt !== 'string') return null
  // preserve behavior while preventing excessively large/unexpected values
  return systemPrompt.slice(0, 20000)
}

function sanitizeMaxTurns(maxTurns, fallback = 20) {
  const n = Number(maxTurns)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < 1) return 1
  if (i > 200) return 200
  return i
}

/**
 * Call the `claude` CLI as a subprocess — same approach as the Discord bot.
 * Strips ANTHROPIC_API_KEY and CLAUDECODE from env to force OAuth credential use.
 */
function runClaude(prompt, { systemPrompt, model, maxTurns = 20, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const safeModel = sanitizeModel(model)
    const safeSystemPrompt = sanitizeSystemPrompt(systemPrompt)
    const safeMaxTurns = sanitizeMaxTurns(maxTurns, 20)

    const args = ['-p', String(prompt), '--output-format', 'json']
    if (safeModel)        args.push('--model', safeModel)
    if (safeSystemPrompt) args.push('--append-system-prompt', safeSystemPrompt)
    if (safeMaxTurns)     args.push('--max-turns', String(safeMaxTurns))

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== 'ANTHROPIC_API_KEY' && k !== 'CLAUDECODE')
    )

    const child = execFile('claude', args, { env, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('[orion-claude] claude CLI error:', err.message, stderr?.slice(0, 300))
        return reject(err)
      }
      resolve(stdout)
    })
    child.unref()
  })
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function getCredStatus() {
  try {
    const raw    = fs.readFileSync(CREDS_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const oauth  = parsed?.claudeAiOauth
    const token  = oauth?.accessToken
    const exp    = oauth?.expiresAt

    if (!token) return { authenticated: false, valid: false, reason: 'No access token' }

    const valid = !exp || exp > Date.now()
    return {
      authenticated: true,
      valid,
      expiresAt: exp ? new Date(exp).toISOString() : null,
      reason: valid ? null : 'Token expired',
    }
  } catch {
    return { authenticated: false, valid: false, reason: 'No credentials file' }
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end',  () => resolve(data))
    req.on('error', reject)
  })
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url    = req.url.split('?')[0]
  const method = req.method

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' })
    return res.end()
  }

  try {
    // ── GET /health ──────────────────────────────────────────────────────────
    if (method === 'GET' && url === '/health') {
      return json(res, 200, { ok: true })
    }

    // ── GET /auth/status ─────────────────────────────────────────────────────
    if (method === 'GET' && url === '/auth/status') {
      return json(res, 200, getCredStatus())
    }

    // ── POST /auth/login ─────────────────────────────────────────────────────
    if (method === 'POST' && url === '/auth/login') {
      // If already running, return current state
      if (loginProc && loginStatus !== 'done' && loginStatus !== 'error') {
        return json(res, 200, {
          status:    loginStatus,
          authUrl:   extractUrl(loginOutput),
          output:    loginOutput,
        })
      }

      resetLogin()
      loginStatus = 'starting'

      console.log('[orion-claude] Starting claude auth login (PTY)...')

      // Use a PTY so claude CLI sees a real terminal and displays the OAuth URL
      loginProc = pty.spawn('claude', ['auth', 'login'], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        env: { ...process.env, HOME: '/root', TERM: 'xterm-color', COLORTERM: 'truecolor' },
      })

      loginProc.onData((chunk) => {
        const clean = stripAnsi(chunk)
        loginOutput += clean
        if (loginStatus === 'starting' && extractUrl(loginOutput)) {
          loginStatus = 'waiting'
          console.log('[orion-claude] Auth URL captured, waiting for code')
        }
        process.stdout.write('[pty] ' + clean.trim() + '\n')
      })

      loginProc.onExit(({ exitCode }) => {
        console.log('[orion-claude] claude auth login exited with code', exitCode)
        if (exitCode === 0) {
          loginStatus = 'done'
          // Copy credentials to shared volume path if needed
          const sharedPath = '/claude-creds/.credentials.json'
          try {
            fs.mkdirSync('/claude-creds', { recursive: true })
            fs.copyFileSync(CREDS_PATH, sharedPath)
            console.log('[orion-claude] Credentials copied to shared volume')
          } catch (e) {
            console.log('[orion-claude] Could not copy to shared volume:', e.message)
          }
        } else if (loginStatus !== 'done') {
          loginStatus = 'error'
        }
        loginProc = null
      })

      // Wait up to 5s for the URL to appear before responding
      let waited = 0
      while (!extractUrl(loginOutput) && waited < 5000 && loginStatus !== 'error') {
        await new Promise(r => setTimeout(r, 200))
        waited += 200
      }

      return json(res, 200, {
        status:  loginStatus,
        authUrl: extractUrl(loginOutput),
        output:  loginOutput,
      })
    }

    // ── POST /auth/code ──────────────────────────────────────────────────────
    if (method === 'POST' && url === '/auth/code') {
      const body = await readBody(req)
      const { code } = JSON.parse(body || '{}')
      const normalizedCode = String(code || '').trim()

      if (!normalizedCode) {
        return json(res, 400, { error: 'code is required' })
      }

      // Accept only expected device/auth code characters to avoid PTY/control injection.
      if (!/^[A-Za-z0-9_-]{4,128}$/.test(normalizedCode)) {
        return json(res, 400, { error: 'Invalid code format' })
      }

      if (!loginProc) {
        return json(res, 400, { error: 'No login in progress — start one first' })
      }

      console.log('[orion-claude] Sending code to PTY...')
      loginProc.write(normalizedCode + '\r')
      loginStatus = 'completing'

      // Give claude a moment to process
      await new Promise(r => setTimeout(r, 1000))

      return json(res, 200, {
        status: loginStatus,
        output: loginOutput,
      })
    }

    // ── GET /auth/poll ───────────────────────────────────────────────────────
    if (method === 'GET' && url === '/auth/poll') {
      return json(res, 200, {
        status:  loginStatus,
        authUrl: extractUrl(loginOutput),
        output:  loginOutput,
        creds:   getCredStatus(),
      })
    }

    // ── POST /auth/cancel ────────────────────────────────────────────────────
    if (method === 'POST' && url === '/auth/cancel') {
      resetLogin()
      return json(res, 200, { ok: true })
    }

    // ── POST /auth/credentials ───────────────────────────────────────────────
    // Store pasted credentials directly to /root/.claude/.credentials.json
    if (method === 'POST' && url === '/auth/credentials') {
      const body = await readBody(req)
      const { credentials } = JSON.parse(body || '{}')
      if (!credentials?.claudeAiOauth?.accessToken) {
        return json(res, 400, { error: 'credentials.claudeAiOauth.accessToken required' })
      }
      fs.mkdirSync(CLAUDE_HOME, { recursive: true })
      fs.writeFileSync(CREDS_PATH, JSON.stringify(credentials, null, 2), 'utf8')
      console.log('[orion-claude] Credentials stored via paste')
      return json(res, 200, { ok: true })
    }

    // ── POST /run ────────────────────────────────────────────────────────────
    // Execute a Claude Code query and stream SDK events back as NDJSON.
    // Each line is one JSON-serialised SDK event (assistant / user / result / error).
    if (method === 'POST' && url === '/run') {
      const body = await readBody(req)
      let opts
      try { opts = JSON.parse(body || '{}') } catch { return json(res, 400, { error: 'Invalid JSON' }) }

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      })

      try {
        const stdout = await runClaude(String(opts.prompt || ''), {
          systemPrompt: opts.systemPrompt,
          model:        opts.model,
          maxTurns:     opts.maxTurns ?? 20,
        })
        // Parse JSON output from claude --output-format json and re-emit as NDJSON events
        try {
          const parsed = JSON.parse(stdout)
          const text = parsed?.result ?? parsed?.text ?? stdout
          res.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n')
          res.write(JSON.stringify({ type: 'result', subtype: 'success', result: text }) + '\n')
        } catch {
          res.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: stdout }] } }) + '\n')
        }
      } catch (err) {
        try { res.write(JSON.stringify({ type: 'error', error: err instanceof Error ? err.message : String(err) }) + '\n') } catch {}
      }
      return res.end()
    }

    // ── POST /run/collect ────────────────────────────────────────────────────
    // Like /run but buffers the full text and returns it as JSON.
    // Used by the plan-reviewer and conversation summariser.
    if (method === 'POST' && url === '/run/collect') {
      const body = await readBody(req)
      let opts
      try { opts = JSON.parse(body || '{}') } catch { return json(res, 400, { error: 'Invalid JSON' }) }

      try {
        const stdout = await runClaude(String(opts.prompt || ''), {
          systemPrompt: opts.systemPrompt,
          model:        opts.model,
          maxTurns:     opts.maxTurns ?? 1,
          timeout:      120000,
        })
        let text = stdout.trim()
        try {
          const parsed = JSON.parse(stdout)
          text = parsed?.result ?? parsed?.text ?? stdout.trim()
        } catch { /* plain text output */ }
        return json(res, 200, { text })
      } catch (err) {
        return json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    }

    json(res, 404, { error: 'Not found' })
  } catch (err) {
    console.error('[orion-claude] Error:', err)
    json(res, 500, { error: err.message })
  }
})

server.listen(PORT, () => {
  console.log(`[orion-claude] Listening on :${PORT}`)
  console.log(`[orion-claude] Credentials path: ${CREDS_PATH}`)
  const status = getCredStatus()
  console.log(`[orion-claude] Auth status: ${JSON.stringify(status)}`)
})
