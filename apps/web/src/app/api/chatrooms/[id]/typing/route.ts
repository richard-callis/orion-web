/**
 * GET /api/chatrooms/[id]/typing
 *
 * Returns the names of agents currently generating a reply in this room.
 * Polled by the frontend every 2s to show a typing indicator.
 *
 * SOC2 [L7]: requires a session and room membership (same rule as the room's
 * messages and SSE stream) — previously any caller could observe activity in any room.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getRoomMember } from '@/lib/room-access'
import { getTyping } from '@/lib/typing-state'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params
  if (!(await getRoomMember(id, session.user.id))) {
    return NextResponse.json({ error: 'Not a member of this room' }, { status: 403 })
  }
  return NextResponse.json({ typing: getTyping(id) })
}
