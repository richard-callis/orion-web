import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'

const CLAUDE_URL = process.env.ORION_CLAUDE_URL ?? 'http://orion-claude:3100'

export async function GET() {
  await requireAdmin()
  try {
    const res = await fetch(`${CLAUDE_URL}/auth/status`, { signal: AbortSignal.timeout(5000) })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ authenticated: false, valid: false, reason: 'Claude Code service unreachable' })
  }
}
