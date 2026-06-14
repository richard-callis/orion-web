import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
export const dynamic = 'force-dynamic'

// GET /api/environments/[id]/evals/rulesets
// List all eval rulesets.
// POST /api/environments/[id]/evals/rulesets
// Create or update a ruleset (admin only).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const envId = (await params).id

  const env = await prisma.environment.findUnique({ where: { id: envId } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })

  const rulesets = await prisma.ruleset.findMany({
    orderBy: { createdAt: 'desc' },
  })

  // Parse JSON fields for the response
  const parsed = rulesets.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    criteria: r.criteria ? JSON.parse(r.criteria) : {},
    triggers: r.triggers ? JSON.parse(r.triggers) : [],
    createdAt: r.createdAt,
  }))

  return NextResponse.json(parsed)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const envId = (await params).id

  // Admin check
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const env = await prisma.environment.findUnique({ where: { id: envId } })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })

  let body: {
    id?: string
    name: string
    description: string
    criteria: Record<string, unknown>
    triggers: string[]
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.name || !body.criteria) {
    return NextResponse.json(
      { error: 'Missing required fields: name, criteria' },
      { status: 400 }
    )
  }

  // If an id is provided, update the existing ruleset
  if (body.id) {
    const existing = await prisma.ruleset.findUnique({
      where: { id: body.id },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Ruleset not found' }, { status: 404 })
    }

    const updated = await prisma.ruleset.update({
      where: { id: body.id },
      data: {
        name: body.name,
        description: body.description ?? existing.description,
        criteria: JSON.stringify(body.criteria),
        triggers: JSON.stringify(body.triggers ?? existing.triggers),
      },
    })

    return NextResponse.json({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      criteria: JSON.parse(updated.criteria),
      triggers: JSON.parse(updated.triggers),
    })
  }

  // Create a new ruleset
  const created = await prisma.ruleset.create({
    data: {
      name: body.name.trim(),
      description: body.description || '',
      criteria: JSON.stringify(body.criteria),
      triggers: JSON.stringify(body.triggers || []),
    },
  })

  return NextResponse.json({
    id: created.id,
    name: created.name,
    description: created.description,
    criteria: JSON.parse(created.criteria),
    triggers: JSON.parse(created.triggers),
  })
}
