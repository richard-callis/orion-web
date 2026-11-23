import { Prisma } from '@prisma/client'

/**
 * Prisma `where` that keeps every agent that is NOT archived. Archiving sets
 * `metadata.archived = true` (lib/tools/agents.ts); active agents usually have
 * no `archived` key, and some have NULL metadata.
 *
 * Do NOT write this as `NOT: { metadata: { path: ['archived'], equals: true } }`.
 * In PostgreSQL that becomes `NOT (metadata #> '{archived}' = 'true')`; when the
 * key (or the whole column) is missing the comparison is NULL, `NOT NULL` is
 * NULL, and the row is dropped — so only agents with an explicit non-true
 * `archived` value would match, i.e. practically none. Each missing case is
 * therefore listed explicitly:
 *   1. metadata IS NULL          (SQL NULL column)
 *   2. metadata #> '{archived}' IS NULL (key absent, or metadata is JSON null)
 *   3. archived <> true          (present but false / any other value)
 */
export function notArchivedAgentWhere(): Prisma.AgentWhereInput {
  return {
    OR: [
      { metadata: { equals: Prisma.DbNull } },
      { metadata: { path: ['archived'], equals: Prisma.DbNull } },
      { metadata: { path: ['archived'], not: true } },
    ],
  }
}
