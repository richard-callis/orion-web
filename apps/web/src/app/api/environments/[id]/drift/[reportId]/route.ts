/**
 * GET /api/environments/:id/drift/:reportId — full report with all findings
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireGatewayAuthForEnvironment } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; reportId: string } },
) {
  const { id } = params
  await requireGatewayAuthForEnvironment(req, id).catch(() => {
    throw Object.assign(new Error('Unauthorized'), { status: 401 })
  })

  const report = await prisma.driftReport.findUnique({
    where: { id: params.reportId },
  })

  if (!report || report.environmentId !== params.id) {
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
