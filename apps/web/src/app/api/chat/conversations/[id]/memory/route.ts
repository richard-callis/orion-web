import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { getToken } from 'next-auth/jwt'

/**
 * GET /api/chat/conversations/[id]/memory
 * Retrieve all memories for a conversation
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) {
    return new Response('Unauthorized', { status: 401 })
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: params.id },
  })
  if (!conversation) {
    return new Response('Conversation not found', { status: 404 })
  }

  const memories = await prisma.memory.findMany({
    where: { conversationId: params.id },
    orderBy: { createdAt: 'asc' },
  })

  return Response.json(memories)
}

/**
 * POST /api/chat/conversations/[id]/memory
 * Create or update a memory (upsert by conversationId + key)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) {
    return new Response('Unauthorized', { status: 401 })
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: params.id },
  })
  if (!conversation) {
    return new Response('Conversation not found', { status: 404 })
  }

  const { key, value, context } = await req.json()

  if (!key || !value) {
    return new Response('key and value are required', { status: 400 })
  }

  // Validate key format (alphanumeric, underscores, hyphens only)
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    return new Response('key must be alphanumeric with underscores or hyphens only', { status: 400 })
  }

  // Limit value size to prevent abuse
  if (value.length > 10000) {
    return new Response('value exceeds maximum length of 10000 characters', { status: 400 })
  }

  await prisma.memory.upsert({
    where: {
      conversationId_key: {
        conversationId: params.id,
        key
      }
    },
    update: {
      value,
      context: context || null,
      updatedAt: new Date(),
    },
    create: {
      conversationId: params.id,
      key,
      value,
      context: context || null,
    },
  })

  return new Response('OK')
}

/**
 * DELETE /api/chat/conversations/[id]/memory?key=<key>
 * Delete a specific memory by key
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) {
    return new Response('Unauthorized', { status: 401 })
  }

  const searchParams = req.nextUrl.searchParams
  const key = searchParams.get('key')

  if (!key) {
    return new Response('key query parameter is required', { status: 400 })
  }

  await prisma.memory.deleteMany({
    where: {
      conversationId: params.id,
      key: key,
    },
  })

  return new Response('OK')
}
