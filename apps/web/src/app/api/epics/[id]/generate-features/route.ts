import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { sanitizeError } from '@/lib/errors'
import fs from 'fs'
import path from 'path'

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const epic = await prisma.epic.findUnique({
    where: { id: params.id },
    include: { features: { include: { _count: { select: { tasks: true } } } } },
  })

  if (!epic) return NextResponse.json({ error: 'Epic not found' }, { status: 404 })
  if (!epic.plan) return NextResponse.json({ error: 'Epic has no plan yet — plan with Claude first' }, { status: 400 })

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

  // Extract JSON array from response (handle cases where Claude wraps it in backticks)
  const jsonMatch = fullText.match(/\[[\s\S]*\]/)
  if (!jsonMatch) {
    return NextResponse.json({ error: 'Claude did not return a valid JSON array', raw: fullText }, { status: 500 })
  }

  let parsed: Array<{ title: string; description?: string }>
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return NextResponse.json({ error: 'Failed to parse Claude response as JSON', raw: fullText }, { status: 500 })
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return NextResponse.json({ error: 'Claude returned an empty or invalid feature list' }, { status: 500 })
  }

  // Create all features in DB
  const created = await Promise.all(
    parsed
      .filter(f => f.title?.trim())
      .map(f =>
        prisma.feature.create({
          data: {
            epicId: params.id,
            title: f.title.trim(),
            description: f.description?.trim() ?? null,
            createdBy: 'claude',
          },
          include: { _count: { select: { tasks: true } } },
        })
      )
  )

  return NextResponse.json({ features: created }, { status: 201 })
}
