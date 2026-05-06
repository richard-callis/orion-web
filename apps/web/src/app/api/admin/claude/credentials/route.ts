/**
 * POST /api/admin/claude/credentials
 * Paste-based credential bootstrap — forwards directly to the orion-claude
 * service which stores them in its own /root/.claude volume.
 *
 * Also writes to /claude-creds/.credentials.json (the path the web container
 * reads via getOAuthToken) for immediate availability without restart.
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import fs from 'fs'

const CLAUDE_URL  = process.env.ORION_CLAUDE_URL ?? 'http://orion-claude:3100'
const LOCAL_CREDS = '/claude-creds/.credentials.json'

export async function POST(req: NextRequest) {
  await requireAdmin()

  const body = await req.json().catch(() => null)
  const raw: string | undefined = body?.credentials

  if (!raw) return NextResponse.json({ error: 'credentials field required' }, { status: 400 })

  let parsed: Record<string, unknown>
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const token = (parsed?.claudeAiOauth as Record<string, unknown> | undefined)?.accessToken
  if (!token) {
    return NextResponse.json({ error: 'JSON must contain claudeAiOauth.accessToken' }, { status: 400 })
  }

  // Write to local volume for immediate web-process pickup
  try {
    fs.mkdirSync('/claude-creds', { recursive: true })
    fs.writeFileSync(LOCAL_CREDS, JSON.stringify(parsed, null, 2), 'utf8')
  } catch { /* volume may not be writable in all environments */ }

  // Also send to orion-claude service so it stores in its native /root/.claude
  try {
    await fetch(`${CLAUDE_URL}/auth/credentials`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ credentials: parsed }),
      signal:  AbortSignal.timeout(5000),
    })
  } catch { /* service may not be up yet */ }

  return NextResponse.json({ ok: true })
}
