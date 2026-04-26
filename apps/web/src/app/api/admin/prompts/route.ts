export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { PROMPT_DEFAULTS } from '@/lib/system-prompts'
import { requireAdmin } from '@/lib/auth'

/** GET /api/admin/prompts — return all prompts, merging DB records with defaults */
export async function GET() {
  await requireAdmin()
  const dbRecords = await prisma.systemPrompt.findMany({ orderBy: { key: 'asc' } })
  const dbMap = new Map(dbRecords.map((r: any) => [r.key, r]))

  // Merge: DB record if it exists, otherwise the default (not yet saved)
  const prompts = PROMPT_DEFAULTS.map(def => {
    const db = dbMap.get(def.key) as any
    return {
      key:         def.key,
      name:        db?.name        ?? def.name,
      description: db?.description ?? def.description,
      category:    db?.category    ?? def.category,
      content:     db?.content     ?? def.content,
      variables:   def.variables   ?? null,
      isDefault:   !db || db.content === def.content,
      updatedAt:   db?.updatedAt   ?? null,
    }
  })

  return NextResponse.json(prompts)
}
