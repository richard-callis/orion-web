/**
 * Conversation ownership helpers — metadata-based scoping (no schema migration).
 *
 * Since `Conversation` has no owner field, we store `ownerId` in `metadata`
 * at creation time and enforce it on all subsequent operations.
 * Legacy rows without `ownerId` are accessible to admins only.
 */
import { getToken } from 'next-auth/jwt'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from './db'
import { requireAdmin } from './auth'

/** Resolve the caller's userId from the JWT token (null if unauthenticated). */
export async function getCallerId(req: NextRequest): Promise<string | null> {
  const token = await getToken({ req })
  return (token?.sub as string) ?? null
}

/**
 * Assert the caller owns the conversation. Returns 401/403 response on failure,
 * or the conversation on success. Admins bypass ownership check.
 */
export async function assertConversationOwner(
  req: NextRequest,
  conversationId: string,
): Promise<{ conversation: { id: string; metadata: unknown } } | NextResponse> {
  const callerId = await getCallerId(req)
  if (!callerId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const convo = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, metadata: true },
  })
  if (!convo) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const meta = convo.metadata as Record<string, unknown> | null
  const ownerId = meta?.ownerId as string | undefined

  // Legacy rows with no ownerId: require admin
  if (!ownerId) {
    try { await requireAdmin() } catch {
      return NextResponse.json(
        { error: 'This conversation predates ownership tracking — admin access required' },
        { status: 403 },
      )
    }
    return { conversation: convo }
  }

  if (ownerId !== callerId) {
    // Allow admins to access any conversation
    try { await requireAdmin() } catch {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  return { conversation: convo }
}
