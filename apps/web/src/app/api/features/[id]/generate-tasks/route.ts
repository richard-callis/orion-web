import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sanitizeError } from '@/lib/errors'
import fs from 'fs'
import path from 'path'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const feature = await prisma.feature.findUnique({
    where: { id: params.id },
    include: { epic: true },
  })

  if (!feature) return NextResponse.json({ error: 'Feature not found' }, { status: 404 })
  if (!feature.plan) return NextResponse.json({ error: 'Feature has no plan yet — plan with Claude first' }, { status: 400 })

  // Set up Claude credentials (same as claude.ts)
  if (process.env.CLAUDE_CREDENTIALS_PATH) {
    const srcCreds = path.join(process.env.CLAUDE_CREDENTIALS_PATH, '.claude', '.credentials.json')
    const claudeHome = '/tmp/claude-home'
    const destDir = path.join(claudeHome, '.claude')
    fs.mkdirSync(destDir, { recursive: true })
    try { fs.copyFileSync(srcCreds, path.join(destDir, '.credentials.json')) } catch { /* ignore */ }
    process.env.HOME = claudeHome
  }

  const { query } = await import('@anthropic-ai/claude-code')

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

  let fullText = ''
  try {
    const response = query({
      prompt,
      options: {
        allowedTools: [],
        maxTurns: 1,
      },
    })

    for await (const msg of response) {
      if (msg.type === 'assistant') {
        const m = msg as { type: 'assistant'; message: { content: Array<{ type: string; text?: string }> } }
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text) fullText += block.text
        }
      } else if (msg.type === 'result') {
        const r = msg as { type: 'result'; subtype?: string; result?: string }
        if (r.subtype === 'success' && r.result && !fullText.includes(r.result.trim())) {
          fullText += r.result
        }
      }
    }
  } catch (err) {
    return NextResponse.json({ error: `Claude error: ${sanitizeError(err)}` }, { status: 500 })
  }

  // Extract JSON array from response
  const jsonMatch = fullText.match(/\[[\s\S]*\]/)
  if (!jsonMatch) {
    return NextResponse.json({ error: 'Claude did not return a valid JSON array', raw: fullText }, { status: 500 })
  }

  let parsed: Array<{ title: string; description?: string; priority?: string }>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return NextResponse.json({ error: 'Failed to parse Claude response as JSON', raw: fullText }, { status: 500 })
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return NextResponse.json({ error: 'Claude returned an empty or invalid task list' }, { status: 500 })
  }

  const validPriorities = new Set(['low', 'medium', 'high', 'critical'])

  const created = await Promise.all(
    parsed
      .filter(t => t.title?.trim())
      .map(t =>
        prisma.task.create({
          data: {
            featureId:   params.id,
            title:       t.title.trim(),
            description: t.description?.trim() ?? null,
            priority:    validPriorities.has(t.priority ?? '') ? t.priority! : 'medium',
            createdBy:   'claude',
          },
          include: { agent: true },
        })
      )
  )

  return NextResponse.json({ tasks: created }, { status: 201 })
}
