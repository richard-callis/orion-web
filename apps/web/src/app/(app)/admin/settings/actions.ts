'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { invalidateAll } from '@/lib/system-cache'

/**
 * Upsert an array of SystemSetting key-value pairs in a single transaction,
 * then flush all in-process caches so new TTLs take effect immediately.
 */
export async function saveSettings(entries: Array<{ key: string; value: string }>) {
  await requireAdmin()

  await prisma.$transaction(
    entries.map(({ key, value }) =>
      prisma.systemSetting.upsert({
        where:  { key },
        update: { value: value as any },
        create: { key,  value: value as any },
      })
    )
  )

  // Flush in-process caches — new TTLs take effect on next access
  invalidateAll()
  revalidatePath('/admin/settings')
}

/**
 * Flush all in-process caches without changing any settings.
 * Useful for forcing a refresh after external changes.
 */
export async function flushCaches() {
  await requireAdmin()
  invalidateAll()
}
