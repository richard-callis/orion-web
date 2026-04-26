import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { createHash } from 'crypto'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/audit/verify
 *
 * Verifies the integrity of the audit log hash chain.
 * Walks from first to last entry and checks that each entry's
 * previousHash matches the hash of the prior entry.
 *
 * Returns detailed results with any broken links in the chain.
 */
export async function GET(req: NextRequest) {
  await requireAdmin()
  const params = req.nextUrl.searchParams
  const limit = Math.min(
    parseInt(params.get('limit') ?? '1000', 10),
    10000,
  ) || 1000

  // Fetch entries ordered by createdAt ascending (oldest first)
  const entries = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: {
      id: true,
      userId: true,
      action: true,
      target: true,
      detail: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      previousHash: true,
    },
  })

  if (entries.length === 0) {
    return NextResponse.json({
      valid: true,
      entryCount: 0,
      message: 'No audit log entries to verify.',
      chain: [],
    })
  }

  const chain: Array<{
    id: string
    index: number
    action: string
    previousHash: string | null
    hash: string
    valid: boolean
    expectedHash: string | null
    note?: string
  }> = []

  let prevHash: string | null = null
  let brokenAt: number | null = null

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]

    // Compute what the previousHash should be
    const expectedPreviousHash = prevHash

    // Compute this entry's hash (for use by the next entry)
    const entryData = {
      id: entry.id,
      userId: entry.userId,
      action: entry.action,
      target: entry.target,
      detail: entry.detail,
      ipAddress: entry.ipAddress,
      userAgent: entry.userAgent,
      createdAt: entry.createdAt,
      previousHash: entry.previousHash,
    }
    const entryHash = createHash('sha256').update(
      JSON.stringify(entryData),
    ).digest('hex')

    const isValid = entry.previousHash === prevHash
    const note = i === 0
      ? 'First entry — previousHash should be null'
      : !isValid && brokenAt === null
        ? 'Chain broken here'
        : undefined

    chain.push({
      id: entry.id,
      index: i,
      action: entry.action,
      previousHash: entry.previousHash,
      hash: entryHash,
      valid: isValid,
      expectedHash: expectedPreviousHash,
      note,
    })

    if (!isValid && brokenAt === null) {
      brokenAt = i
    }

    // The next entry's previousHash should be THIS entry's hash
    prevHash = entryHash
  }

  const valid = brokenAt === null

  return NextResponse.json({
    valid,
    entryCount: entries.length,
    brokenAt: brokenAt ?? undefined,
    chain: chain.slice(0, 100), // Return first 100 entries for inspection
    chainComplete: entries.length <= 100,
  })
}
