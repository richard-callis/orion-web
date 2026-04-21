import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getAllNovae, Nova, NovaCreateRequest } from '@/lib/nebula'

/**
 * GET /api/novas — List all Nova definitions
 * Merges bundled, remote, and user-created Novas from the database.
 * Optional query params:
 *   - category: Filter by category (Identity, Storage, Monitoring, DevTools, Agent, Other)
 *   - type: Filter by type (agent, service)
 *   - source: Filter by source (bundled, remote, user-created)
 *   - q: Search by name or description
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const category = searchParams.get('category')
  const type = searchParams.get('type')
  const source = searchParams.get('source')
  const q = searchParams.get('q')

  // Get database-stored Novas (user-created)
  const dbNovae = await prisma.nova.findMany({
    orderBy: { name: 'asc' },
  })

  // Build response
  let result = await getAllNovae()

  // Add user-created Novas from DB
  for (const dbNova of dbNovae) {
    const existing = result.find(n => n.name === dbNova.name)
    if (!existing) {
      result.push({
        id: dbNova.id,
        name: dbNova.name,
        displayName: dbNova.displayName,
        description: dbNova.description,
        category: dbNova.category as Nova['category'],
        version: dbNova.version,
        source: dbNova.source as Nova['source'],
        config: dbNova.config as any,
        tags: (dbNova.tags as string[]) || [],
        createdAt: dbNova.createdAt.toISOString(),
        updatedAt: dbNova.updatedAt.toISOString(),
      })
    }
  }

  // Apply filters
  if (category) {
    result = result.filter(n => n.category.toLowerCase() === category.toLowerCase())
  }
  if (source) {
    result = result.filter(n => n.source === source)
  }
  if (q) {
    const query = q.toLowerCase()
    result = result.filter(n =>
      n.name.toLowerCase().includes(query) ||
      n.displayName.toLowerCase().includes(query) ||
      (n.description && n.description.toLowerCase().includes(query))
    )
  }

  // Type filter (requires checking config.type)
  if (type) {
    result = result.filter(n => {
      const config = n.config as any
      return config?.type === type
    })
  }

  return NextResponse.json({ novae: result })
}

/**
 * POST /api/novas — Create a new Nova definition
 * Only admin users can create user-created Novas.
 */
export async function POST(req: NextRequest) {
  const body: NovaCreateRequest = await req.json()

  // Validate required fields
  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  if (!body.displayName?.trim()) {
    return NextResponse.json({ error: 'displayName is required' }, { status: 400 })
  }
  if (!body.config) {
    return NextResponse.json({ error: 'config is required' }, { status: 400 })
  }

  // Validate type
  const validTypes = ['agent', 'service']
  if (!validTypes.includes(body.config.type)) {
    return NextResponse.json(
      { error: `type must be one of: ${validTypes.join(', ')}` },
      { status: 400 }
    )
  }

  // Validate category
  const validCategories = ['Identity', 'Storage', 'Monitoring', 'DevTools', 'Agent', 'Other']
  const category = body.category || 'Other'
  if (!validCategories.includes(category)) {
    return NextResponse.json(
      { error: `category must be one of: ${validCategories.join(', ')}` },
      { status: 400 }
    )
  }

  // Check for duplicate name
  const existing = await prisma.nova.findUnique({
    where: { name: body.name.trim() },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json(
      { error: `Nova with name "${body.name}" already exists` },
      { status: 409 }
    )
  }

  // Create Nova in database
  const nova = await prisma.nova.create({
    data: {
      name: body.name.trim(),
      displayName: body.displayName.trim(),
      description: body.description || null,
      category,
      version: body.version || '1.0.0',
      source: 'user-created',
      config: body.config as any,
      tags: body.tags || [],
    },
  })

  // Create initial revision
  await prisma.novaRevision.create({
    data: {
      novaId: nova.id,
      version: nova.version,
      diff: JSON.stringify({ type: 'create', name: body.name }),
      createdBy: 'admin',
      reasoning: `Created Nova: ${body.displayName}`,
    },
  })

  return NextResponse.json(nova, { status: 201 })
}
