/**
 * GET /api/environments/:id/drift/:reportId — full report with all findings
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireGatewayAuthForEnvironment } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; reportId: string }> },
) {
  const { id } = await params
  await requireGatewayAuthForEnvironment(req, id).catch(() => {
    throw Object.assign(new Error('Unauthorized'), { status: 401 })
  })

  const report = await prisma.driftReport.findUnique({
    where: { id: (await params).reportId },
  })

  if (!report || report.environmentId !== (await params).id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  let findings: unknown[] = []
  try { findings = JSON.parse(report.findings) } catch { /* empty */ }

  return NextResponse.json({
    id:            report.id,
    environmentId: report.environmentId,
    status:        report.status,
    driftCount:    report.driftCount,
    scannedAt:     report.scannedAt.toISOString(),
    findings,
  })
}
