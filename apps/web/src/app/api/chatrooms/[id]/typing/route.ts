/**
 * GET /api/chatrooms/[id]/typing
 *
 * Returns the names of agents currently generating a reply in this room.
 * Polled by the frontend every 2s to show a typing indicator.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getTyping } from '@/lib/typing-state'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  return NextResponse.json({ typing: getTyping(id) })
}
