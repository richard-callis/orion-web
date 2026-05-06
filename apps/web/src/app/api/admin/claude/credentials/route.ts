import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import fs from 'fs'

const CREDS_PATH = '/claude-creds/.claude/.credentials.json'

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

  fs.mkdirSync('/claude-creds/.claude', { recursive: true })
  fs.writeFileSync(CREDS_PATH, JSON.stringify(parsed, null, 2), 'utf8')

  return NextResponse.json({ ok: true })
}
