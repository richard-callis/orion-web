/**
 * Claude Code OAuth proxy routes
 *
 * POST /api/admin/claude/oauth/login   — start the login flow on the orion-claude service
 * POST /api/admin/claude/oauth/code    — forward the pasted code to the running login process
 * GET  /api/admin/claude/oauth/poll    — poll login progress and output
 * POST /api/admin/claude/oauth/cancel  — cancel any running login
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'

const CLAUDE_URL = process.env.ORION_CLAUDE_URL ?? 'http://orion-claude:3100'

async function proxy(path: string, method: string, body?: unknown) {
  const res = await fetch(`${CLAUDE_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body:    body ? JSON.stringify(body) : undefined,
    signal:  AbortSignal.timeout(10_000),
  })
  return res.json()
}

export async function POST(req: NextRequest) {
  const url    = new URL(req.url)
  const action = url.searchParams.get('action') ?? 'login'

  try {
    await requireAdmin()

    if (action === 'login') {
      const data = await proxy('/auth/login', 'POST')
      return NextResponse.json(data)
    }

    if (action === 'code') {
      const body = await req.json().catch(() => ({}))
      const data = await proxy('/auth/code', 'POST', { code: body.code })
      return NextResponse.json(data)
    }

    if (action === 'cancel') {
      const data = await proxy('/auth/cancel', 'POST')
      return NextResponse.json(data)
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[claude-oauth] POST error:', msg)
    const isAuth = msg === 'Unauthorized'
    return NextResponse.json(
      { error: isAuth ? 'Unauthorized' : `Claude Code service unreachable: ${msg}` },
      { status: isAuth ? 401 : 503 }
    )
  }
}

export async function GET(req: NextRequest) {
  const url    = new URL(req.url)
  const action = url.searchParams.get('action') ?? 'poll'

  try {
    await requireAdmin()

    if (action === 'poll') {
      const data = await proxy('/auth/poll', 'GET')
      return NextResponse.json(data)
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[claude-oauth] GET error:', msg)
    const isAuth = msg === 'Unauthorized'
    return NextResponse.json(
      { error: isAuth ? 'Unauthorized' : `Claude Code service unreachable: ${msg}` },
      { status: isAuth ? 401 : 503 }
    )
  }
}
