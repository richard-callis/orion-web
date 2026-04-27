/**
 * Redis pub/sub for real-time chat message delivery.
 *
 * Architecture:
 * - Messages are stored in PostgreSQL (persistent, auditable source of truth)
 * - Redis pub/sub distributes messages in real-time to connected SSE clients
 * - Each room has a channel: `chat:room:{roomId}`
 * - Message format: { id, roomId, agentId, content, senderType, createdAt, sender }
 *
 * Configuration:
 *   Uses same Redis setup as rate-limit-redis.ts (REDIS_URL, REDIS_SENTINEL_*, etc)
 *   Falls back to no-op if Redis unavailable (SSE still works via polling)
 */

import type { ChatMessage } from '@prisma/client'

let Redis: any = null
let redisClient: any = null
let redisPubClient: any = null
let redisAvailable = false

const redisUrls = [
  process.env.REDIS_URL,
  process.env.UPSTASH_REDIS_URL,
  'redis://localhost:6379/0',
]

async function initRedisClient(): Promise<boolean> {
  if (redisClient) return true

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ioredis = await import('ioredis')
    Redis = ioredis.default || ioredis
  } catch {
    return false
  }

  try {
    const sentinelMaster = process.env.REDIS_SENTINEL_MASTER
    const sentinelNodes = process.env.REDIS_SENTINEL_NODES

    if (sentinelMaster && sentinelNodes) {
      const nodes = sentinelNodes.split(',').map((node) => {
        const [host, port] = node.trim().split(':')
        return { host, port: parseInt(port || '26379', 10) }
      })

      redisClient = new Redis({
        sentinels: nodes,
        name: sentinelMaster,
        db: 0,
        sentinelPassword: process.env.REDIS_SENTINEL_PASSWORD,
        password: process.env.REDIS_PASSWORD,
      })
      redisPubClient = new Redis({
        sentinels: nodes,
        name: sentinelMaster,
        db: 0,
        sentinelPassword: process.env.REDIS_SENTINEL_PASSWORD,
        password: process.env.REDIS_PASSWORD,
      })
    } else {
      const url = redisUrls.find((u: any) => u && u.trim())
      if (!url) return false
      redisClient = new Redis(url)
      redisPubClient = new Redis(url)
    }

    await redisClient.ping()
    redisAvailable = true
    return true
  } catch (error) {
    redisClient = null
    redisPubClient = null
    redisAvailable = false
    return false
  }
}

/**
 * Publish a chat message to Redis for real-time delivery.
 * Called after message is saved to PostgreSQL.
 */
export async function publishChatMessage(
  roomId: string,
  message: any,
): Promise<void> {
  if (!redisAvailable) {
    const ok = await initRedisClient()
    if (!ok) return // Graceful degradation if Redis unavailable
  }

  if (!redisPubClient) return

  try {
    const channel = `chat:room:${roomId}`
    const payload = JSON.stringify(message)
    await redisPubClient.publish(channel, payload)
  } catch (error) {
    console.error(`[chat-redis] Failed to publish message to ${roomId}:`, error)
    redisAvailable = false
    redisPubClient = null
  }
}

/**
 * Subscribe to chat messages for a room (used by SSE endpoint).
 * Calls callback for each message received.
 *
 * @returns Unsubscribe function
 */
export async function subscribeToChatRoom(
  roomId: string,
  onMessage: (message: any) => void,
): Promise<() => Promise<void>> {
  if (!redisAvailable) {
    const ok = await initRedisClient()
    if (!ok) {
      // Return no-op unsubscribe if Redis unavailable
      return async () => {}
    }
  }

  if (!redisClient) {
    return async () => {}
  }

  try {
    const channel = `chat:room:${roomId}`
    const subscriber = redisPubClient!.duplicate()

    subscriber.on('message', (_channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message)
        onMessage(parsed)
      } catch (e) {
        console.error(`[chat-redis] Failed to parse message:`, e)
      }
    })

    subscriber.on('error', (error: any) => {
      console.error(`[chat-redis] Subscription error for ${roomId}:`, error)
    })

    await subscriber.subscribe(channel)

    // Return unsubscribe function
    return async () => {
      try {
        await subscriber.unsubscribe(channel)
        await subscriber.quit()
      } catch (e) {
        console.error(`[chat-redis] Error unsubscribing:`, e)
      }
    }
  } catch (error) {
    console.error(`[chat-redis] Failed to subscribe to ${roomId}:`, error)
    redisAvailable = false
    return async () => {}
  }
}

/**
 * Get Redis connection status for health checks.
 */
export async function getChatRedisStatus(): Promise<{
  available: boolean
}> {
  if (redisAvailable) return { available: true }

  const initOk = await initRedisClient()
  if (initOk) return { available: true }

  return { available: false }
}
