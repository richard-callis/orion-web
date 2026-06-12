import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireServiceAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try { await requireServiceAuth(req) } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { searchParams } = new URL(req.url)
  const days = Math.min(parseInt(searchParams.get('days') ?? '30', 10) || 30, 365)

  const since = new Date()
  since.setDate(since.getDate() - days)
  since.setHours(0, 0, 0, 0)

  const [records, externalModels] = await Promise.all([
    prisma.agentTokenUsage.findMany({
      where: { recordedAt: { gte: since } },
      include: { agent: { select: { id: true, name: true } } },
      orderBy: { recordedAt: 'asc' },
    }),
    prisma.externalModel.findMany({
      select: { modelId: true, selfHosted: true, inputPricePer1M: true, outputPricePer1M: true },
    }),
  ])

  // Build a pricing lookup keyed by modelId
  const pricingMap = new Map<string, {
    selfHosted: boolean
    inputPricePer1M: number | null
    outputPricePer1M: number | null
  }>()
  for (const m of externalModels) {
    pricingMap.set(m.modelId, {
      selfHosted: m.selfHosted,
      inputPricePer1M:  m.inputPricePer1M  ? Number(m.inputPricePer1M)  : null,
      outputPricePer1M: m.outputPricePer1M ? Number(m.outputPricePer1M) : null,
    })
  }

  function calcCost(modelId: string | null, inputTokens: number, outputTokens: number) {
    if (!modelId) return { costUsd: null, savingsUsd: null, selfHosted: false }
    const pricing = pricingMap.get(modelId)
    if (!pricing || (pricing.inputPricePer1M === null && pricing.outputPricePer1M === null)) {
      return { costUsd: null, savingsUsd: null, selfHosted: pricing?.selfHosted ?? false }
    }
    const inputRate  = pricing.inputPricePer1M  ?? 0
    const outputRate = pricing.outputPricePer1M ?? 0
    const usd = (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000
    return {
      costUsd:    pricing.selfHosted ? null : usd,
      savingsUsd: pricing.selfHosted ? usd  : null,
      selfHosted: pricing.selfHosted,
    }
  }

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostUsd = 0
  let totalSavingsUsd = 0
  const taskSet = new Set<string>()

  const agentMap = new Map<string, {
    agentId: string; agentName: string
    inputTokens: number; outputTokens: number
    costUsd: number; savingsUsd: number
    tasks: Set<string>
  }>()
  const modelMap = new Map<string, {
    modelId: string; selfHosted: boolean
    inputTokens: number; outputTokens: number
    costUsd: number; savingsUsd: number
  }>()
  const dayMap = new Map<string, {
    inputTokens: number; outputTokens: number
    costUsd: number; savingsUsd: number
  }>()

  for (const r of records) {
    totalInputTokens  += r.inputTokens
    totalOutputTokens += r.outputTokens
    if (r.taskId) taskSet.add(r.taskId as string)

    const mId = (r as any).modelId as string | null
    const { costUsd, savingsUsd, selfHosted } = calcCost(mId, r.inputTokens, r.outputTokens)
    totalCostUsd    += costUsd    ?? 0
    totalSavingsUsd += savingsUsd ?? 0

    // By agent
    const agentId   = r.agentId
    const agentName = r.agent?.name ?? agentId
    if (!agentMap.has(agentId)) {
      agentMap.set(agentId, { agentId, agentName, inputTokens: 0, outputTokens: 0, costUsd: 0, savingsUsd: 0, tasks: new Set() })
    }
    const ag = agentMap.get(agentId)!
    ag.inputTokens  += r.inputTokens
    ag.outputTokens += r.outputTokens
    ag.costUsd      += costUsd    ?? 0
    ag.savingsUsd   += savingsUsd ?? 0
    if (r.taskId) ag.tasks.add(r.taskId as string)

    // By model
    if (mId) {
      if (!modelMap.has(mId)) modelMap.set(mId, { modelId: mId, selfHosted, inputTokens: 0, outputTokens: 0, costUsd: 0, savingsUsd: 0 })
      const m = modelMap.get(mId)!
      m.inputTokens  += r.inputTokens
      m.outputTokens += r.outputTokens
      m.costUsd      += costUsd    ?? 0
      m.savingsUsd   += savingsUsd ?? 0
    }

    // By day
    const dateKey = r.recordedAt.toISOString().slice(0, 10)
    if (!dayMap.has(dateKey)) dayMap.set(dateKey, { inputTokens: 0, outputTokens: 0, costUsd: 0, savingsUsd: 0 })
    const day = dayMap.get(dateKey)!
    day.inputTokens  += r.inputTokens
    day.outputTokens += r.outputTokens
    day.costUsd      += costUsd    ?? 0
    day.savingsUsd   += savingsUsd ?? 0
  }

  const byDay = []
  for (let i = 0; i < days; i++) {
    const d = new Date(since)
    d.setDate(d.getDate() + i)
    const key   = d.toISOString().slice(0, 10)
    const entry = dayMap.get(key) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, savingsUsd: 0 }
    byDay.push({ date: key, ...entry })
  }

  const byAgent = Array.from(agentMap.values()).map(a => ({
    agentId:      a.agentId,
    agentName:    a.agentName,
    inputTokens:  a.inputTokens,
    outputTokens: a.outputTokens,
    costUsd:      a.costUsd,
    savingsUsd:   a.savingsUsd,
    tasks:        a.tasks.size,
  })).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))

  const byModel = Array.from(modelMap.values())
    .sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))

  return NextResponse.json({
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd:    Math.round(totalCostUsd    * 1_000_000) / 1_000_000,
    totalSavingsUsd: Math.round(totalSavingsUsd * 1_000_000) / 1_000_000,
    totalTasks: taskSet.size,
    byAgent,
    byModel,
    byDay,
  })
}
