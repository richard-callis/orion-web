'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { invalidateAll } from '@/lib/system-cache'
import { EMBEDDING_MODEL_ERROR, isRefusedDefault } from '@/lib/embedding-models'

/**
 * Upsert an array of SystemSetting key-value pairs in a single transaction,
 * then flush all in-process caches so new TTLs take effect immediately.
 */
export async function saveSettings(entries: Array<{ key: string; value: string }>): Promise<{ error?: string }> {
  await requireAdmin()

  for (const { key, value } of entries) {
    // Returned, not thrown: Next.js hides thrown messages in production.
    if (await isRefusedDefault(key, value)) return { error: `${key}: that ${EMBEDDING_MODEL_ERROR}` }
  }

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
  return {}
}

/**
 * Flush all in-process caches without changing any settings.
 * Useful for forcing a refresh after external changes.
 */
export async function flushCaches() {
  await requireAdmin()
  invalidateAll()
}
