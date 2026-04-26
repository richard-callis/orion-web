/**
 * Webhook idempotency — prevents duplicate processing on webhook retries.
 *
 * SOC2: [CC7] Replay attack prevention for webhook handlers.
 */

interface IdempotencyEntry {
  seenAt: number
}

const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_CACHE_SIZE = 5000

const cache = new Map<string, IdempotencyEntry>()

/**
 * Check if a webhook ID has been seen recently.
 * Returns true if this is a duplicate (should be skipped).
 */
export function isDuplicateWebhookId(id: string): boolean {
  if (!id) return false

  const now = Date.now()

  if (cache.has(id)) {
    return true
  }

  cache.set(id, { seenAt: now })

  // Evict old entries if cache is full
  if (cache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(cache.entries())
    entries.sort((a, b) => a[1].seenAt - b[1].seenAt)
    // Remove oldest 25%
    const removeCount = Math.floor(MAX_CACHE_SIZE * 0.25)
    for (let i = 0; i < removeCount; i++) {
      cache.delete(entries[i][0])
    }
  }

  return false
}

/**
 * Extract the webhook delivery ID from request headers.
 * Returns null if no delivery ID is present.
 */
export function extractWebhookId(headers: Record<string, string>): string | null {
  // GitHub: X-GitHub-Delivery
  // GitLab: X-Gitlab-Event (not a unique ID, but X-Gitlab-Token could be used)
  // Gitea: X-Gitea-Delivery (if available) or X-Gitea-Event + timestamp
  return (
    headers['x-github-delivery'] ??
    headers['x-gitea-delivery'] ??
    headers['x-hook-delivery-id'] ??
    null
  )
}

/**
 * Check if a webhook is too old (replay attack prevention).
 * Checks X-GitHub-Timestamp header (epoch seconds).
 * Returns true if the webhook should be rejected.
 */
export function isStaleWebhook(headers: Record<string, string>): boolean {
  const timestampStr = headers['x-github-timestamp'] ?? headers['x-timestamp']
  if (!timestampStr) return false

  const webhookTime = parseInt(timestampStr, 10) * 1000 // convert seconds to ms
  const now = Date.now()

  // Reject webhooks older than 5 minutes
  return (now - webhookTime) > 5 * 60 * 1000
}
