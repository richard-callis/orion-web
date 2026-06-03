/**
 * GET /api/chatrooms/[id]/stream
 *
 * Server-Sent Events (SSE) endpoint for real-time chat messages.
 *
 * Flow:
 * 1. Client opens EventSource connection
 * 2. Server subscribes to Redis pub/sub channel for this room
 * 3. When messages are created, they're published to Redis
 * 4. SSE sends messages to client in real-time
 * 5. Client updates UI without polling
 *
 * Fallback: If Redis is unavailable, SSE still works but client falls back to polling.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { subscribeToChatRoom } from '@/lib/chat-redis'

export const runtime = 'nodejs' // SSE requires Node.js runtime
export const maxDuration = 60 // 60 second timeout (clients should reconnect)

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: roomId } = await params

  // Verify user has access to this room
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const room = await prisma.chatRoom.findUnique({
    where: { id: roomId },
    select: { id: true },
  })

  if (!room) {
    return NextResponse.json({ error: 'Room not found' }, { status: 404 })
  }

  // B2 fix: SSE stream only checked that a session exists, not that the user
  // is a member of this room. Any logged-in user could subscribe to the security
  // room and receive incident details live. Verify membership.
  const membership = await prisma.chatRoomMember.findFirst({
    where: { roomId, userId: session.user.id },
    select: { userId: true },
  })
  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this room' }, { status: 403 })
  }

  // Create SSE stream
  const encoder = new TextEncoder()
  let unsubscribe: (() => Promise<void>) | null = null

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Send initial connected message
        controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'))

        // Subscribe to Redis pub/sub
        unsubscribe = await subscribeToChatRoom(roomId, (message) => {
          try {
            const data = JSON.stringify(message)
            controller.enqueue(encoder.encode(`data: ${data}\n\n`))
          } catch (e) {
            console.error('[SSE] Error encoding message:', e)
          }
        })
      } catch (error) {
        console.error('[SSE] Stream start error:', error)
        controller.error(error)
      }
    },

    cancel() {
      // Cleanup when client disconnects
      if (unsubscribe) {
        unsubscribe().catch((e) => {
          console.error('[SSE] Error unsubscribing:', e)
        })
      }
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable buffering in nginx/proxies
    },
  })
}
