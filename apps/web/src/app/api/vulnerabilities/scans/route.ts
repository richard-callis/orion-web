export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { z } from 'zod'
import { runDailyScan } from '@/jobs/security-scan-vulns'

const TriggerSchema = z.object({
  environmentId: z.string().min(1).max(100),
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
    select: { id: true, name: true },
  })
  if (!env) return NextResponse.json({ error: 'Environment not found' }, { status: 404 })

  const scan = await prisma.vulnerabilityScan.create({
    data: {
      environmentId: parsed.data.environmentId,
      driver: 'trivy',
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
      const results = await runDailyScan()
      const totals = results.reduce(
        (acc, r) => ({
          findingsCreated: acc.findingsCreated + r.findingsCreated,
          findingsEscalated: acc.findingsEscalated + r.findingsEscalated,
          findingsFixed: acc.findingsFixed + r.findingsFixed,
        }),
        { findingsCreated: 0, findingsEscalated: 0, findingsFixed: 0 }
      )
      await prisma.vulnerabilityScan.update({
        where: { id: scan.id },
        data: { status: 'completed', completedAt: new Date(), ...totals },
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
