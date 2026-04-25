export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { PROMPT_DEFAULTS, invalidatePromptCache } from '@/lib/system-prompts'
import { requireAdmin } from '@/lib/auth'

/** GET /api/admin/prompts/:key — get a single prompt's current content */
export async function GET(
  _req: NextRequest,
  { params }: { params: { key: string } },
) {
  await requireAdmin()
  const key = decodeURIComponent(params.key)
  const def = PROMPT_DEFAULTS.find(p => p.key === key)
  if (!def) return NextResponse.json({ error: 'Unknown prompt key' }, { status: 404 })

  const db = await prisma.systemPrompt.findUnique({ where: { key } })
  return NextResponse.json({
    key,
    content:   db?.content     ?? def.content,
    variables: def.variables   ?? null,
    isDefault: !db || db.content === def.content,
  })
}

/** PUT /api/admin/prompts/:key — save edited prompt content */
export async function PUT(
  req: NextRequest,
  { params }: { params: { key: string } },
) {
  await requireAdmin()
  const { content } = await req.json() as { content?: string }
  if (typeof content !== 'string') {
    return NextResponse.json({ error: 'content is required' }, { status: 400 })
  }

  const key = decodeURIComponent(params.key)
  const def = PROMPT_DEFAULTS.find(p => p.key === key)
  if (!def) {
    return NextResponse.json({ error: 'Unknown prompt key' }, { status: 404 })
  }

  const record = await prisma.systemPrompt.upsert({
    where: { key },
    update: { content },
    create: {
      key,
      name:        def.name,
      description: def.description,
      category:    def.category,
      content,
      variables:   (def.variables ?? null) as unknown as object,
    },
  })

  invalidatePromptCache(key)

  return NextResponse.json({ key: record.key, content: record.content, updatedAt: record.updatedAt })
}

/** POST /api/admin/prompts/:key/reset — restore to default */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { key: string } },
) {
  await requireAdmin()
  const key = decodeURIComponent(params.key)
  const def = PROMPT_DEFAULTS.find(p => p.key === key)
  if (!def) return NextResponse.json({ error: 'Unknown prompt key' }, { status: 404 })

  await prisma.systemPrompt.upsert({
    where: { key },
    update: { content: def.content },
    create: {
      key,
      name:        def.name,
      description: def.description,
      category:    def.category,
      content:     def.content,
      variables:   (def.variables ?? null) as unknown as object,
    },
  })

  invalidatePromptCache(key)
  return NextResponse.json({ key, content: def.content, reset: true })
}
