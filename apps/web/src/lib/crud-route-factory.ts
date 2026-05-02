import { NextRequest, NextResponse } from 'next/server'
import type { ZodType } from 'zod'
import { prisma } from '@/lib/db'
import { parseBodyOrError } from '@/lib/validate'
import { requireServiceAuth } from '@/lib/auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Caller = any

export function makeCrudRoutes(config: {
  model: string
  createSchema: ZodType
  requireAuth?: boolean                  // default true
  include?: object
  orderBy?: object | object[]
  listFilters?: string[]                 // query param names forwarded as where filters
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transformData?: (data: any, caller: Caller) => Record<string, unknown>
  afterCreate?: (record: unknown, caller: Caller) => Promise<void>
}) {
  const needsAuth = config.requireAuth !== false

  return {
    GET: async (req: NextRequest) => {
      if (needsAuth) await requireServiceAuth(req)
      const where: Record<string, unknown> = {}
      if (config.listFilters?.length) {
        const url = new URL(req.url)
        for (const f of config.listFilters) {
          const v = url.searchParams.get(f)
          if (v != null) where[f] = v
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const records = await (prisma as any)[config.model].findMany({
        ...(Object.keys(where).length ? { where } : {}),
        ...(config.orderBy !== undefined ? { orderBy: config.orderBy } : {}),
        ...(config.include ? { include: config.include } : {}),
      })
      return NextResponse.json(records)
    },

    POST: async (req: NextRequest) => {
      const caller: Caller = needsAuth ? await requireServiceAuth(req) : null
      const result = await parseBodyOrError(req, config.createSchema)
      if ('error' in result) return result.error

      const raw = result.data as Record<string, unknown>
      const data = config.transformData ? config.transformData(raw, caller) : raw

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const record = await (prisma as any)[config.model].create({
        data,
        ...(config.include ? { include: config.include } : {}),
      })

      if (config.afterCreate) {
        await config.afterCreate(record, caller).catch(() => {})
      }

      return NextResponse.json(record, { status: 201 })
    },
  }
}
