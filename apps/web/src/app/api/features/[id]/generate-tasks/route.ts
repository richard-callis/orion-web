/**
 * POST /api/features/[id]/generate-tasks
 *
 * Uses the system default AI model to break a feature plan into backlog tasks.
 * Configure the default model in Settings → AI.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { callDefaultModel } from '@/lib/default-model'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const feature = await prisma.feature.findUnique({
    where: { id },
    include: { epic: true },
  })

  if (!feature) return NextResponse.json({ error: 'Feature not found' }, { status: 404 })
  if (!feature.plan) return NextResponse.json({ error: 'Feature has no plan yet — plan with Claude first' }, { status: 400 })

  const prompt = `You are breaking down a feature plan into concrete backlog tasks for a software project.

Epic: "${feature.epic.title}"
Feature: "${feature.title}"
${feature.description ? `Feature description: ${feature.description}\n` : ''}
Feature plan:
${feature.plan}

Break this plan into specific, actionable backlog tasks. Each task should be something a developer can pick up and complete independently. Be concrete — not too vague, not too granular.

For each task include:
- "title": short imperative title (e.g. "Add retry logic to webhook handler")
- "description": 1-2 sentences explaining what needs to be done
- "priority": one of "low", "medium", "high", "critical"

Return ONLY a valid JSON array. No markdown, no explanation, just the JSON:
[
  { "title": "Task title", "description": "What needs to be done.", "priority": "medium" },
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

  const jsonMatch = fullText.match(/\[[\s\S]*\]/)
  if (!jsonMatch) {
    return NextResponse.json({ error: 'Model did not return a valid JSON array', raw: fullText }, { status: 500 })
  }

  let parsed: Array<{ title: string; description?: string; priority?: string }>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return NextResponse.json({ error: 'Failed to parse model response as JSON', raw: fullText }, { status: 500 })
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return NextResponse.json({ error: 'Model returned an empty or invalid task list' }, { status: 500 })
  }

  const validPriorities = new Set(['low', 'medium', 'high', 'critical'])

  const created = await Promise.all(
    parsed
      .filter(t => t.title?.trim())
      .map(t =>
        prisma.task.create({
          data: {
            featureId:   id,
            title:       t.title.trim(),
            description: t.description?.trim() ?? null,
            priority:    validPriorities.has(t.priority ?? '') ? t.priority! : 'medium',
            createdBy:   'ai',
          },
          include: { agent: true },
        })
      )
  )

  return NextResponse.json({ tasks: created }, { status: 201 })
}
