export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { resizeSession } from '@/lib/terminal-sessions'

export async function POST(
  req: NextRequest,
  { params }: { params: { sessionId: string } },
) {
  const { cols, rows } = await req.json() as { cols?: number; rows?: number }
  if (typeof cols === 'number' && typeof rows === 'number') {
    resizeSession(params.sessionId, cols, rows)
  }
  return NextResponse.json({ ok: true })
}
