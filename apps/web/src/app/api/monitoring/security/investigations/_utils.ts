import { requireAdmin, getCurrentUser } from '@/lib/auth'
/**
 * Shared utilities for investigation API routes.
 */

import { type Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import { timingSafeEqual } from 'crypto'
import { decryptStrict } from '@/lib/encryption'

/**
 * Server-resolved identity of the caller of an investigation API route.
 *
 * `isWarden` is only ever true when it was derived from a DB-verified
 * agent identity (never from anything the client sent in the request body).
 */
export interface ResolvedActor {
  /** Value to store as the actor of record (username, or agent name). */
  id: string
  /** Coarse actor kind, as recorded in audit entries. */
  type: 'human' | 'warden' | 'agent'
  isWarden: boolean
}

/**
 * Resolve the authenticated actor for an investigation API request.
 *
 * SECURITY: actor identity must NEVER be taken from the request body/JSON
 * (e.g. a client-supplied `_actor` field) — that lets any caller, including
 * a prompt-injected Warden agent, fabricate or omit its identity and bypass
 * the Warden-specific constraints below (or forge audit attribution).
 *
 * Two supported, server-verified identities:
 *  - Human session: `requireAdmin()` — an authenticated admin user. Actor is
 *    the session user's username.
 *  - Autonomous agent call: authenticated the same way the MCP endpoint
 *    authenticates per-agent tool calls (see `/api/mcp/route.ts`) — an
 *    `x-mcp-token` header plus `agentId` query param, verified against that
 *    agent's stored per-agent token. `isWarden` is only set when the agent
 *    record's name is actually 'Warden' (mirrors `requireWardenAgent` in
 *    `src/lib/siem/warden-management-tools.ts`).
 *
 * Throws if neither identity can be established (caller should map to 401).
 */
export async function resolveActor(req: Request): Promise<ResolvedActor> {
  const user = await getCurrentUser()
  if (user && user.role === 'admin') {
    return { id: user.username, type: 'human', isWarden: false }
  }

  const url = new URL(req.url)
  const agentId = url.searchParams.get('agentId')
  const token = req.headers.get('x-mcp-token')
  if (agentId && token) {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, name: true, mcpToken: true },
    })
    if (agent?.mcpToken) {
      let storedToken: string | null = null
      try {
        storedToken = decryptStrict(agent.mcpToken, 'mcpToken')
      } catch { /* falls through to Unauthorized below */ }
      if (storedToken) {
        const a = Buffer.from(token)
        const b = Buffer.from(storedToken)
        if (a.length === b.length && timingSafeEqual(a, b)) {
          const isWarden = agent.name === 'Warden'
          return { id: agent.name ?? agent.id, type: isWarden ? 'warden' : 'agent', isWarden }
        }
      }
    }
  }

  throw new Error('Unauthorized')
}

/**
 * Record an audit entry for an investigation.
 */
export async function recordAudit(
  investigationId: string,
  actorId: string,
  actorType: string,
  action: string,
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
): Promise<void> {
  await prisma.investigationAudit.create({
    data: {
      investigationId,
      actorId,
      actorType,
      action,
      before: before as Prisma.InputJsonValue,
      after: after as Prisma.InputJsonValue,
    },
  })
}

/**
 * Build a tsvector search vector from note content for full-text search.
 * Called application-side on note insert/update.
 */
export async function updateSearchVector(
  noteId: string,
  content: string,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "InvestigationNote" SET "searchVector" = to_tsvector('english', $1) WHERE "id" = $2`,
    content,
    noteId,
  )
}

/**
 * Full-text search notes within an investigation.
 */
export async function searchNotes(
  investigationId: string,
  query: string,
  limit: number = 25,
): Promise<Array<{ id: string; content: string; author: string; authorType: string; createdAt: Date }>> {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT "id", "content", "author", "authorType", "createdAt"
     FROM "InvestigationNote"
     WHERE "investigationId" = $1 AND "searchVector" @@ plainto_tsquery('english', $2)
     ORDER BY "createdAt" DESC
     LIMIT $3`,
    investigationId,
    query,
    limit,
  )
  return rows as any
}

