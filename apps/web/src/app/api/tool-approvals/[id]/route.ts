import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'

// POST /api/tool-approvals/[id]  body: { action: 'approve'|'deny', adminNote?: string, approvedBy?: string }
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json()
  const { action, adminNote, approvedBy } = body as { action: 'approve' | 'deny'; adminNote?: string; approvedBy?: string }

  const request = await prisma.toolApprovalRequest.findUnique({ where: { id: params.id } })
  if (!request) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (request.status !== 'pending') return NextResponse.json({ error: 'Already resolved' }, { status: 400 })

  const updated = await prisma.toolApprovalRequest.update({
    where: { id: params.id },
    data: {
      status:     action === 'approve' ? 'approved' : 'denied',
      approvedBy: approvedBy ?? null,
      adminNote:  adminNote ?? null,
      resolvedAt: new Date(),
    },
  })

  // On approval: create a one-time execution grant (expires in 30 minutes)
  if (action === 'approve') {
    await prisma.toolExecutionGrant.create({
      data: {
        userId:        request.userId,
        environmentId: request.environmentId,
        toolName:      request.toolName,
        expiresAt:     new Date(Date.now() + 30 * 60 * 1000),
      },
    })
  }

  return NextResponse.json(updated)
}
