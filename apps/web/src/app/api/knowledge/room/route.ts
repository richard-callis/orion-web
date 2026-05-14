/**
 * /api/knowledge/room — Room-scoped knowledge CRUD.
 *
 * GET  ?roomId=<id>&query=<text>  — search room knowledge
 * POST { roomId, title, content, type?, tags? } — create entry
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { parseBodyOrError } from '@/lib/validate'

const CreateRoomKnowledgeSchema = z.object({
  roomId:  z.string().min(1),
  title:   z.string().min(1).max(500),
  content: z.string().min(1),
  type:    z.enum(['note', 'runbook', 'context', 'decision']).optional().default('note'),
  tags:    z.array(z.string()).optional(),
})

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const query  = searchParams.get('query') ?? ''
  const roomId = searchParams.get('roomId')

  if (!roomId) return Response.json({ error: 'roomId required' }, { status: 400 })

  const results = await prisma.roomKnowledge.findMany({
    where: {
      roomId,
      ...(query
        ? {
            OR: [
              { title:   { contains: query, mode: 'insensitive' } },
              { content: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    take: 10,
    orderBy: { updatedAt: 'desc' },
  })

  return Response.json(results)
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  const result = await parseBodyOrError(req, CreateRoomKnowledgeSchema)
  if ('error' in result) return result.error

  const { roomId, title, content, type, tags } = result.data

  const entry = await prisma.roomKnowledge.create({
    data: { roomId, title, content, type: type ?? 'note', tags: tags ?? [] },
  })

  return Response.json(entry, { status: 201 })
}
