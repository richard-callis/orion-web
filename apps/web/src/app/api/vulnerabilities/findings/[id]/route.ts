import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { z } from 'zod'

const PatchSchema = z.object({
  status: z.enum(['open', 'fixed', 'accepted', 'false_positive']),
  acceptedRiskJustification: z.string().min(10).max(2000).optional(),
  acceptedRiskExpiresAt: z.string().datetime().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user
  try { user = await requireAuth() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { id } = await params

  let body: unknown
  try { body = await req.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 })
  }
  const { status, acceptedRiskJustification, acceptedRiskExpiresAt } = parsed.data

  if (status === 'accepted' && !acceptedRiskJustification) {
    return NextResponse.json({ error: 'Justification required when accepting risk' }, { status: 400 })
  }

  const finding = await prisma.vulnerabilityFinding.findUnique({ where: { id } })
  if (!finding) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  let updated
  try {
    updated = await prisma.vulnerabilityFinding.update({
      where: { id },
      data: {
        status,
        acceptedRiskJustification: status === 'accepted' ? acceptedRiskJustification : null,
        acceptedRiskExpiresAt: status === 'accepted' && acceptedRiskExpiresAt
          ? new Date(acceptedRiskExpiresAt) : null,
      },
    })
  } catch (e: any) {
    if (e?.code === 'P2025') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    throw e
  }

  if (status === 'accepted') {
    logAudit({
      userId: user.id,
      action: 'cve_finding_accept_risk',
      target: `vulnerability:${id}`,
      detail: {
        cveId: finding.cveId,
        environmentId: finding.environmentId,
        justification: acceptedRiskJustification,
        expiresAt: acceptedRiskExpiresAt ?? null,
      },
    }).catch(() => {})
  }

  return NextResponse.json(updated)
}
