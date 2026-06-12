/**
 * GET  /api/environments/:id/drift      — last 10 drift reports with findings
 * POST /api/environments/:id/drift      — manually trigger a drift scan
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireGatewayAuthForEnvironment } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { detectGitOpsDriftForEnv } from '@/jobs/gitops-drift'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params
  await requireGatewayAuthForEnvironment(req, id).catch(() => {
    throw Object.assign(new Error('Unauthorized'), { status: 401 })
  })

  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const reports = await prisma.driftReport.findMany({
    where:   { environmentId: params.id },
    orderBy: { scannedAt: 'desc' },
    take:    10,
  })

  const parsed = reports.map(r => ({
    id:            r.id,
    environmentId: r.environmentId,
    status:        r.status,
    driftCount:    r.driftCount,
    scannedAt:     r.scannedAt.toISOString(),
    findings:      safeParseFindings(r.findings),
  }))

  return NextResponse.json({ reports: parsed })
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params
  await requireGatewayAuthForEnvironment(req, id).catch(() => {
    throw Object.assign(new Error('Unauthorized'), { status: 401 })
  })

  const env = await prisma.environment.findUnique({ where: { id: params.id } })
  if (!env) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  try {
    await detectGitOpsDriftForEnv(params.id)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }

  // Return the freshly-created report
  const latest = await prisma.driftReport.findFirst({
    where:   { environmentId: params.id },
    orderBy: { scannedAt: 'desc' },
  })
  if (!latest) return NextResponse.json({ ok: true })

  return NextResponse.json({
    ok:      true,
    report: {
      id:            latest.id,
      environmentId: latest.environmentId,
      status:        latest.status,
      driftCount:    latest.driftCount,
      scannedAt:     latest.scannedAt.toISOString(),
      findings:      safeParseFindings(latest.findings),
    },
  })
}

function safeParseFindings(raw: string): unknown[] {
  try { return JSON.parse(raw) } catch { return [] }
}
