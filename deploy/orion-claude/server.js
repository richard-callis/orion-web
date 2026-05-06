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

const http  = require('http')
const { spawn } = require('child_process')
const fs    = require('fs')
const path  = require('path')

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

function extractUrl(text) {
  const m = text.match(/https:\/\/[^\s\n]+/)
  return m ? m[0] : null
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

      console.log('[orion-claude] Starting claude login...')

      loginProc = spawn('claude', ['login'], {
        env:   { ...process.env, HOME: '/root', TERM: 'dumb' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      loginProc.stdout.on('data', (chunk) => {
        loginOutput += chunk.toString()
        if (loginStatus === 'starting' && extractUrl(loginOutput)) {
          loginStatus = 'waiting'
          console.log('[orion-claude] Auth URL captured, waiting for code')
        }
        console.log('[stdout]', chunk.toString().trim())
      })

      loginProc.stderr.on('data', (chunk) => {
        loginOutput += chunk.toString()
        console.log('[stderr]', chunk.toString().trim())
      })

      loginProc.on('close', (code) => {
        console.log('[orion-claude] claude login exited with code', code)
        if (code === 0) {
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

      loginProc.on('error', (err) => {
        loginOutput += `\nProcess error: ${err.message}\n`
        loginStatus = 'error'
        loginProc   = null
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

      if (!code?.trim()) {
        return json(res, 400, { error: 'code is required' })
      }

      if (!loginProc) {
        return json(res, 400, { error: 'No login in progress — start one first' })
      }

      console.log('[orion-claude] Sending code to claude stdin...')
      loginProc.stdin.write(code.trim() + '\n')
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
        const { query } = await import('@anthropic-ai/claude-code')
        const response = query({
          prompt: String(opts.prompt || ''),
          options: {
            allowedTools:     opts.allowedTools ?? [],
            maxTurns:         opts.maxTurns     ?? 20,
            ...(opts.systemPrompt && { customSystemPrompt: opts.systemPrompt }),
            ...(opts.model        && { model: opts.model }),
          },
        })
        for await (const event of response) {
          res.write(JSON.stringify(event) + '\n')
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
        const { query } = await import('@anthropic-ai/claude-code')
        const response = query({
          prompt: String(opts.prompt || ''),
          options: {
            allowedTools:     opts.allowedTools ?? [],
            maxTurns:         opts.maxTurns     ?? 1,
            ...(opts.systemPrompt && { customSystemPrompt: opts.systemPrompt }),
            ...(opts.model        && { model: opts.model }),
          },
        })
        let text = ''
        for await (const event of response) {
          if (event.type === 'assistant') {
            for (const block of event.message?.content ?? []) {
              if (block.type === 'text') text += block.text
            }
          } else if (event.type === 'result' && event.subtype === 'success') {
            if (event.result && !text.includes(event.result.trim())) text += (text ? '\n\n' : '') + event.result
          }
        }
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
