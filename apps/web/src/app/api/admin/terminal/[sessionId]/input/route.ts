export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { writeToSession } from '@/lib/terminal-sessions'

export async function POST(
  req: NextRequest,
  { params }: { params: { sessionId: string } },
) {
  const { data } = await req.json() as { data?: string }
  if (typeof data !== 'string') {
    return NextResponse.json({ error: 'data required' }, { status: 400 })
  }
  const ok = writeToSession(params.sessionId, data)
  return NextResponse.json({ ok })
}
