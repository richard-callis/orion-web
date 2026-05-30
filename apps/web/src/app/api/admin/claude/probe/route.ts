/**
 * GET /api/admin/claude/probe
 *
 * Forwards a live end-to-end test to the orion-claude sidecar.
 * The sidecar actually invokes the claude CLI and returns whether it succeeded.
 * Result is cached in the sidecar for 5 minutes.
 */
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'

const CLAUDE_URL = process.env.ORION_CLAUDE_URL ?? 'http://orion-claude:3100'

export async function GET() {
  await requireAdmin()
  try {
    const res = await fetch(`${CLAUDE_URL}/auth/probe`, { signal: AbortSignal.timeout(40000) })
    const data = await res.json()
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ ok: false, error: 'Claude Code service unreachable' })
  }
}
