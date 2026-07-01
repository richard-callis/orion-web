export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { z } from 'zod'
import { runDailyScan } from '@/jobs/security-scan-vulns'

const TriggerSchema = z.object({
  environmentId: z.string().min(1).max(100),
  driver: z.enum(['trivy', 'acas']).default('trivy'),
})

export async function GET() {
  try { await requireAuth() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const scans = await prisma.vulnerabilityScan.findMany({
    orderBy: { startedAt: 'desc' },
    take: 50,
    include: { environment: { select: { name: true } } },
  })
  return NextResponse.json(scans)
}

export async function POST(req: NextRequest) {
  try { await requireAuth() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = TriggerSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
  }

  const env = await prisma.environment.findUnique({
    where: { id: parsed.data.environmentId },
    select: { id: true, name: true, status: true },
  })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })
  if (env.status !== 'connected') return NextResponse.json({ error: 'Environment is not connected' }, { status: 409 })

  const scan = await prisma.vulnerabilityScan.create({
    data: {
      environmentId: parsed.data.environmentId,
      driver: parsed.data.driver,
      status: 'pending',
      triggeredBy: 'user',
    },
  })

  // Fire and forget — update scan status in background
  ;(async () => {
    try {
      await prisma.vulnerabilityScan.update({
        where: { id: scan.id },
        data: { status: 'running', startedAt: new Date() },
      })
      const results = await runDailyScan(parsed.data.environmentId, parsed.data.driver, scan.id)
      const totals = results.reduce(
        (acc, r) => ({
          findingsCreated: acc.findingsCreated + r.findingsCreated,
          findingsEscalated: acc.findingsEscalated + r.findingsEscalated,
          findingsFixed: acc.findingsFixed + r.findingsFixed,
          errors: [...acc.errors, ...r.errors],
        }),
        { findingsCreated: 0, findingsEscalated: 0, findingsFixed: 0, errors: [] as string[] }
      )
      const allErrored = results.length === 0 || results.every(r => r.errors.length > 0)
      const someErrored = totals.errors.length > 0
      const status = allErrored ? 'failed' : someErrored ? 'completed_with_errors' : 'completed'
      const errorMessage = totals.errors.length > 0 ? totals.errors.join('\n') : undefined
      await prisma.vulnerabilityScan.update({
        where: { id: scan.id },
        data: { status, completedAt: new Date(), findingsCreated: totals.findingsCreated, findingsEscalated: totals.findingsEscalated, findingsFixed: totals.findingsFixed, ...(errorMessage ? { errorMessage } : {}) },
      })
    } catch (e) {
      await prisma.vulnerabilityScan.update({
        where: { id: scan.id },
        data: { status: 'failed', completedAt: new Date(), errorMessage: String(e) },
      }).catch(() => {})
    }
  })()

  return NextResponse.json(scan, { status: 202 })
}
