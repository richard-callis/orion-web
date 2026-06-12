/**
 * /api/knowledge/agent — Agent-scoped knowledge CRUD.
 *
 * GET  ?agentId=<id>&query=<text>  — search agent knowledge
 * POST { agentId, title, content, type?, tags? } — create entry
 */

import { NextRequest } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { parseBodyOrError } from '@/lib/validate'

const CreateAgentKnowledgeSchema = z.object({
  agentId: z.string().min(1),
  title:   z.string().min(1).max(500),
  content: z.string().min(1),
  type:    z.enum(['note', 'runbook', 'context', 'lesson']).optional().default('note'),
  tags:    z.array(z.string()).optional(),
})

export async function GET(req: NextRequest) {
  try { await requireAdmin() } catch { return Response.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { searchParams } = new URL(req.url)
  const query   = searchParams.get('query') ?? ''
  const agentId = searchParams.get('agentId')

  if (!agentId) return Response.json({ error: 'agentId required' }, { status: 400 })

  const results = await prisma.agentKnowledge.findMany({
    where: {
      agentId,
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
  try { await requireAdmin() } catch { return Response.json({ error: 'Unauthorized' }, { status: 401 }) }

  const result = await parseBodyOrError(req, CreateAgentKnowledgeSchema)
  if ('error' in result) return result.error

  const { agentId, title, content, type, tags } = result.data

  const entry = await prisma.agentKnowledge.create({
    data: { agentId, title, content, type: type ?? 'note', tags: tags ?? [] },
  })

  return Response.json(entry, { status: 201 })
}
