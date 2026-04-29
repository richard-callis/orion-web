/**
 * POST /api/epics/[id]/generate-features
 *
 * Uses the system default AI model to extract features from an epic plan.
 * Configure the default model in Settings → AI.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { callDefaultModel } from '@/lib/default-model'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const epic = await prisma.epic.findUnique({
    where: { id },
    include: { features: { include: { _count: { select: { tasks: true } } } } },
  })

  if (!epic) return NextResponse.json({ error: 'Epic not found' }, { status: 404 })
  if (!epic.plan) return NextResponse.json({ error: 'Epic has no plan yet — plan with Claude first' }, { status: 400 })

  const prompt = `You are extracting features from an epic plan for a software project.

Epic title: "${epic.title}"
${epic.description ? `Epic description: ${epic.description}\n` : ''}
Plan:
${epic.plan}

Identify the distinct features (major functional areas or deliverables) from this plan that should each be tracked as a separate feature. A feature is a meaningful unit of work — not too granular, not too broad.

Return ONLY a valid JSON array. No markdown, no explanation, just the JSON array:
[
  { "title": "Short feature name", "description": "One or two sentences describing what this feature delivers." },
  ...
]`

  let fullText: string
  try {
    fullText = await callDefaultModel(prompt)
  } catch (err) {
    return NextResponse.json(
      { error: `AI error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 },
    )
  }

  // Extract JSON array from response (handle cases where model wraps it in backticks)
  const jsonMatch = fullText.match(/\[[\s\S]*\]/)
  if (!jsonMatch) {
    return NextResponse.json({ error: 'Model did not return a valid JSON array', raw: fullText }, { status: 500 })
  }

  let parsed: Array<{ title: string; description?: string }>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return NextResponse.json({ error: 'Failed to parse model response as JSON', raw: fullText }, { status: 500 })
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return NextResponse.json({ error: 'Model returned an empty or invalid feature list' }, { status: 500 })
  }

  const created = await Promise.all(
    parsed
      .filter(f => f.title?.trim())
      .map(f =>
        prisma.feature.create({
          data: {
            epicId: id,
            title: f.title.trim(),
            description: f.description?.trim() ?? null,
            createdBy: 'ai',
          },
          include: { _count: { select: { tasks: true } } },
        })
      )
  )

  return NextResponse.json({ features: created }, { status: 201 })
}
