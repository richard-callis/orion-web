import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { syncNebula } from '@/lib/nebula-loader'

/**
 * GET /api/nebulae — List all registered Nebulae
 */
export async function GET() {
  const nebulae = await prisma.nebula.findMany({ orderBy: { createdAt: 'asc' }, take: 500 })
  return NextResponse.json(nebulae)
}

/**
 * POST /api/nebulae — Register a new Nebula (git-backed Nova catalog)
 * Body: { name, gitUrl, displayName?, description?, branch?, path? }
 */
export async function POST(req: NextRequest) {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  if (!body.name || !body.gitUrl) {
    return NextResponse.json({ error: 'name and gitUrl are required' }, { status: 400 })
  }

  const nebula = await prisma.nebula.create({
    data: {
      name: body.name,
      displayName: body.displayName ?? body.name,
      description: body.description ?? null,
      gitUrl: body.gitUrl,
      branch: body.branch ?? 'main',
      path: body.path ?? 'novas',
    },
  })

  // Sync Novas from the repo in background
  syncNebula(nebula.id).catch(console.error)

  return NextResponse.json(nebula, { status: 201 })
}
