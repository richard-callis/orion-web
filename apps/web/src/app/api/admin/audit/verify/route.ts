import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { hashAuditEntryWithMode } from '@/lib/audit'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/audit/verify
 *
 * Verifies the integrity of the audit log hash chain.
 *
 * By default, verifies the MOST RECENT `limit` entries (tail-first), since
 * that is what matters for a live compliance check — a table with more than
 * `limit` rows would otherwise only ever have its oldest entries checked,
 * leaving recent tampering (the attack this control is meant to catch)
 * invisible. Use the `before` query param (an entry id) to page backwards
 * through older windows of the log; a full-log audit requires paginating
 * with `before` until the start of the table is reached.
 *
 * Query params:
 *   - limit: number of entries to verify (default 1000, max 10000)
 *   - before: entry id — verify the `limit` entries immediately preceding
 *     (and including) this id, instead of the most recent ones.
 *
 * Each entry's hash is recomputed using the hashing mode (HMAC vs unkeyed
 * SHA-256) that was active when that entry was created, determined from the
 * `audit.hmac_chain_start` SystemSetting marker written by the writer when
 * HMAC was first enabled. Entries created before that marker's `startedAt`
 * were chained with unkeyed SHA-256 and must be verified the same way, or
 * every pre-cutover entry will falsely report as tampered.
 */
export async function GET(req: NextRequest) {
  await requireAdmin()
  const params = req.nextUrl.searchParams
  const limit = Math.min(
    parseInt(params.get('limit') ?? '1000', 10),
    10000,
  ) || 1000
  const before = params.get('before')

  // Look up the HMAC chain-start marker so we know, per-entry, whether it was
  // written under the keyed or unkeyed hashing scheme. If no marker exists,
  // every entry was written unkeyed (HMAC has never been enabled on this
  // install), so default to useHmac = false for all entries.
  const chainStartSetting = await prisma.systemSetting.findUnique({
    where: { key: 'audit.hmac_chain_start' },
  })
  const hmacStartedAt = chainStartSetting
    ? new Date((chainStartSetting.value as { startedAt: string }).startedAt)
    : null

  const selectFields = {
    id: true,
    userId: true,
    action: true,
    target: true,
    detail: true,
    ipAddress: true,
    userAgent: true,
    createdAt: true,
    previousHash: true,
  } as const

  // Fetch the window to verify. Default: the most recent `limit` entries
  // (tail-first), since that's what a live tamper check needs to catch.
  // With `before`, fetch the `limit` entries immediately preceding that id
  // instead, to allow paging through older parts of a large log.
  const windowDesc = await prisma.auditLog.findMany({
    where: before ? { id: { lt: before } } : undefined,
    orderBy: [{ id: 'desc' }],
    take: limit,
    select: selectFields,
  })

  // Walk oldest-to-newest for the hash chain comparison.
  const entries = [...windowDesc].reverse()

  if (entries.length === 0) {
    return NextResponse.json({
      valid: true,
      entryCount: 0,
      message: 'No audit log entries to verify.',
      chain: [],
    })
  }

  // Fetch exactly one entry before the window's oldest entry, so we can
  // validate the link INTO the window rather than assuming the window's
  // first entry has no predecessor. If this is truly the first entry in the
  // whole table, there is nothing before it and prevHash stays null.
  const entryBefore = await prisma.auditLog.findFirst({
    where: { id: { lt: entries[0].id } },
    orderBy: [{ id: 'desc' }],
    select: selectFields,
  })

  const useHmacFor = (createdAt: Date): boolean =>
    hmacStartedAt !== null && createdAt >= hmacStartedAt

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

  let prevHash: string | null = entryBefore
    ? hashAuditEntryWithMode(entryBefore, useHmacFor(entryBefore.createdAt))
    : null
  let brokenAt: number | null = null

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]

    // Compute what the previousHash should be
    const expectedPreviousHash = prevHash

    // Compute this entry's hash using the hashing mode active at the time it
    // was created (HMAC after the chain-start marker, unkeyed before it).
    const entryHash = hashAuditEntryWithMode(entry, useHmacFor(entry.createdAt))

    const isValid = entry.previousHash === prevHash
    const note = i === 0
      ? entryBefore
        ? 'First entry in this window — chain verification starts fresh at this window boundary; entries before it were not re-verified in this call.'
        : 'First entry — previousHash should be null'
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
    windowOldestId: entries[0].id,
    windowNewestId: entries[entries.length - 1].id,
    hasOlderEntries: entryBefore !== null,
    chain: chain.slice(0, 100), // Return first 100 entries for inspection
    chainComplete: entries.length <= 100,
  })
}
