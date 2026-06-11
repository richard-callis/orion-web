import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  await requireServiceAuth(req)
  const { searchParams } = new URL(req.url)
  const days = Math.min(parseInt(searchParams.get('days') ?? '30', 10) || 30, 365)

  const since = new Date()
  since.setDate(since.getDate() - days)
  since.setHours(0, 0, 0, 0)

  const records = await prisma.agentTokenUsage.findMany({
    where: { recordedAt: { gte: since } },
    include: { agent: { select: { id: true, name: true } } },
    orderBy: { recordedAt: 'asc' },
  })

  let totalInputTokens = 0
  let totalOutputTokens = 0
  const taskSet = new Set<string>()

  const agentMap = new Map<string, {
    agentId: string
    agentName: string
    inputTokens: number
    outputTokens: number
    tasks: Set<string>
  }>()

  const modelMap = new Map<string, { modelId: string; inputTokens: number; outputTokens: number }>()

  const dayMap = new Map<string, { inputTokens: number; outputTokens: number }>()

  for (const r of records) {
    totalInputTokens += r.inputTokens
    totalOutputTokens += r.outputTokens

    if (r.taskId) taskSet.add(r.taskId as string)

    const agentId = r.agentId
    const agentName = r.agent?.name ?? agentId
    if (!agentMap.has(agentId)) {
      agentMap.set(agentId, { agentId, agentName, inputTokens: 0, outputTokens: 0, tasks: new Set() })
    }
    const ag = agentMap.get(agentId)!
    ag.inputTokens += r.inputTokens
    ag.outputTokens += r.outputTokens
    if (r.taskId) ag.tasks.add(r.taskId as string)

    const mId = (r as any).modelId as string | null
    if (mId) {
      if (!modelMap.has(mId)) modelMap.set(mId, { modelId: mId, inputTokens: 0, outputTokens: 0 })
      const m = modelMap.get(mId)!
      m.inputTokens += r.inputTokens
      m.outputTokens += r.outputTokens
    }

    const dateKey = r.recordedAt.toISOString().slice(0, 10)
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, { inputTokens: 0, outputTokens: 0 })
    const day = dayMap.get(dateKey)!
    day.inputTokens += r.inputTokens
    day.outputTokens += r.outputTokens
  }

  // Fill all days in window (including zeros)
  const byDay: Array<{ date: string; inputTokens: number; outputTokens: number }> = []
  for (let i = 0; i < days; i++) {
    const d = new Date(since)
    d.setDate(d.getDate() + i)
    const key = d.toISOString().slice(0, 10)
    const entry = dayMap.get(key) ?? { inputTokens: 0, outputTokens: 0 }
    byDay.push({ date: key, ...entry })
  }

  const byAgent = Array.from(agentMap.values()).map(a => ({
    agentId: a.agentId,
    agentName: a.agentName,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
    tasks: a.tasks.size,
  })).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))

  const byModel = Array.from(modelMap.values())
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))

  return NextResponse.json({
    totalInputTokens,
    totalOutputTokens,
    totalTasks: taskSet.size,
    byAgent,
    byModel,
    byDay,
  })
}
