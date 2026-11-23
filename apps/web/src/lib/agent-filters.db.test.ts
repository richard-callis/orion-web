// Runs the filter against a real PostgreSQL. Skipped unless ORION_TEST_DATABASE_URL
// points at a throwaway, fully migrated database (see apps/web/prisma/check-drift.sh);
// it is separate from DATABASE_URL so the suite never touches a live database by accident.
// e.g. docker run -d --rm -e POSTGRES_PASSWORD=x -p 55432:5432 pgvector/pgvector:pg16
//      DATABASE_URL=postgresql://postgres:x@localhost:55432/postgres apps/web/prisma/check-drift.sh
//      ORION_TEST_DATABASE_URL=$that npm test --workspace apps/web -- agent-filters.db
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Prisma, PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { notArchivedAgentWhere } from './agent-filters'

const url = process.env.ORION_TEST_DATABASE_URL

describe.skipIf(!url)('notArchivedAgentWhere against PostgreSQL', () => {
  const prefix = `afdb-${Date.now()}-`
  const cases: Record<string, Prisma.InputJsonValue | typeof Prisma.DbNull | typeof Prisma.JsonNull> = {
    'sql-null':       Prisma.DbNull,
    'json-null':      Prisma.JsonNull,
    'empty-object':   {},
    'no-archived':    { systemPrompt: 'x' },
    'archived-false': { archived: false },
    'archived-null':  { archived: null },
    'archived-true':  { archived: true },
  }
  let prisma: PrismaClient

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) })
    for (const [name, metadata] of Object.entries(cases)) {
      const agent = await prisma.agent.create({ data: { name: prefix + name, metadata } })
      await prisma.task.create({ data: { title: prefix + name, assignedAgent: agent.id } })
    }
  })

  afterAll(async () => {
    await prisma.task.deleteMany({ where: { title: { startsWith: prefix } } })
    await prisma.agent.deleteMany({ where: { name: { startsWith: prefix } } })
    await prisma.$disconnect()
  })

  const allExceptArchived = Object.keys(cases).filter(n => n !== 'archived-true').sort()

  it('selects every agent except archived:true', async () => {
    const agents = await prisma.agent.findMany({
      where: { name: { startsWith: prefix }, ...notArchivedAgentWhere() },
      select: { name: true },
    })
    expect(agents.map(a => a.name.slice(prefix.length)).sort()).toEqual(allExceptArchived)
  })

  it('counts the same agents', async () => {
    const n = await prisma.agent.count({ where: { name: { startsWith: prefix }, ...notArchivedAgentWhere() } })
    expect(n).toBe(allExceptArchived.length)
  })

  it('selects tasks of those agents via the relation filter used by the worker poll', async () => {
    const tasks = await prisma.task.findMany({
      where: { title: { startsWith: prefix }, agent: notArchivedAgentWhere() },
      select: { title: true },
    })
    expect(tasks.map(t => t.title.slice(prefix.length)).sort()).toEqual(allExceptArchived)
  })
})
