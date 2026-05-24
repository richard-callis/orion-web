/**
 * Shared utilities for investigation API routes.
 */

import { prisma } from '@/lib/db'
import { type Prisma } from '@prisma/client'

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

/**
 * Cursor pagination helper. Returns { items, nextCursor, hasMore }.
 */
export async function cursorPaginate<T>(
  model: Prisma.Model,
  where: Record<string, unknown>,
  orderBy: Record<string, 'asc' | 'desc'>,
  limit: number,
  cursor: string | null,
  select?: Record<string, true>,
) {
  const take = limit + 1
  const cursorOpt = cursor ? { id: cursor } : undefined

  const items = await (model as any).findMany({
    where, orderBy, take, cursor: cursorOpt,
    select: select || undefined,
  })

  const hasMore = items.length > limit
  const data = items.slice(0, limit)
  const nextCursor = hasMore ? items[items.length - 1].id : null
  return { items: data, nextCursor, hasMore }
}
