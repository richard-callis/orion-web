/**
 * System Epic seeding — runs on startup via instrumentation.ts.
 *
 * Seeds a permanent "System" epic with features that system agents use as
 * their communication space. All records are created idempotently (by title
 * for the epic/features, by featureId for rooms) so restarts are safe.
 *
 * Structure:
 *   Epic: "System"
 *     Feature: "Health"      → ChatRoom for Pulse reports + cluster health tasks
 *     Feature: "Operations"  → ChatRoom for Alpha/Validator cycle summaries
 *     Feature: "Maintenance" → ChatRoom for scheduled upkeep, upgrades, patches
 *
 * After seeding, room IDs are stored in SystemSetting:
 *   system.room.health      → ChatRoom ID for the Health feature
 *   system.room.operations  → ChatRoom ID for the Operations feature
 *   system.room.maintenance → ChatRoom ID for the Maintenance feature
 *
 * The worker reads these settings and injects them into each watcher's
 * enriched prompt so agents always know where to post.
 */

import { prisma } from './db'

interface SystemFeatureDef {
  title:       string
  description: string
  settingKey:  string   // SystemSetting key where the room ID is stored
  agents:      string[] // agent displayNames to add as members
}

const SYSTEM_FEATURES: SystemFeatureDef[] = [
  {
    title:       'Health',
    description: 'Cluster health monitoring. Pulse posts ingress and SSL status reports here. Fix tasks are tracked in this feature.',
    settingKey:  'system.room.health',
    agents:      ['Pulse', 'Alpha', 'Sentinel'],
  },
  {
    title:       'Operations',
    description: 'Day-to-day operational activity. Alpha and Validator post cycle summaries here.',
    settingKey:  'system.room.operations',
    agents:      ['Alpha', 'Validator'],
  },
  {
    title:       'Maintenance',
    description: 'Scheduled maintenance, upgrades, and routine housekeeping tasks.',
    settingKey:  'system.room.maintenance',
    agents:      ['Alpha', 'Warden', 'Archivist'],
  },
]

export async function ensureSystemEpic(): Promise<void> {
  try {
    // 1. Upsert the System epic (match by title)
    let epic = await prisma.epic.findFirst({ where: { title: 'System' } })
    if (!epic) {
      epic = await prisma.epic.create({
        data: {
          title:       'System',
          description: 'Reserved for system-level operations. Features here are owned by system agents — Alpha, Validator, Pulse, and other persistent watchers.',
          status:      'active',
          createdBy:   'system',
        },
      })
      console.log(`[seed] Created System epic (${epic.id})`)
    }

    for (const def of SYSTEM_FEATURES) {
      // 2. Upsert feature (match by epicId + title)
      let feature = await prisma.feature.findFirst({
        where: { epicId: epic.id, title: def.title },
      })
      if (!feature) {
        feature = await prisma.feature.create({
          data: {
            epicId:      epic.id,
            title:       def.title,
            description: def.description,
            status:      'active',
            createdBy:   'system',
          },
        })
        console.log(`[seed] Created System feature: ${def.title} (${feature.id})`)
      }

      // 3. Upsert ChatRoom (@@unique on featureId guarantees one room per feature)
      let room = await prisma.chatRoom.findFirst({ where: { featureId: feature.id } })
      if (!room) {
        room = await prisma.chatRoom.create({
          data: {
            name:       `System — ${def.title}`,
            description: def.description,
            type:       'ops',
            featureId:  feature.id,
            epicId:     epic.id,
            createdBy:  'system',
          },
        })
        console.log(`[seed] Created system chatroom: ${room.name} (${room.id})`)
      }

      // 4. Store room ID in SystemSetting so the worker can inject it into watch prompts
      await prisma.systemSetting.upsert({
        where:  { key: def.settingKey },
        update: { value: room.id },
        create: { key: def.settingKey, value: room.id },
      })

      // 5. Add system agents as members (skip if already a member)
      const agentRecords = await prisma.agent.findMany({
        where: { name: { in: def.agents } },
        select: { id: true, name: true },
      })

      for (const agent of agentRecords) {
        await prisma.chatRoomMember.upsert({
          where:  { roomId_agentId: { roomId: room.id, agentId: agent.id } },
          update: {},
          create: { roomId: room.id, agentId: agent.id, role: 'member' },
        })
      }
    }
    // 6. Seed default ORION system service URLs (create-only — admin can override via UI)
    //    Uses internal Docker network hostnames so checks work from inside the container.
    const systemServices: Record<string, string> = {
      'system.service.orion':  'http://orion:3000',
      'system.service.gitea':  'http://gitea:3000',
      'system.service.vault':  'http://vault-proxy:8200',
    }
    for (const [key, value] of Object.entries(systemServices)) {
      const existing = await prisma.systemSetting.findUnique({ where: { key } })
      if (!existing) {
        await prisma.systemSetting.create({ data: { key, value } })
        console.log(`[seed] Registered system service: ${key} → ${value}`)
      }
    }
  } catch (err) {
    console.error('[seed] Failed to seed system epic:', err instanceof Error ? err.message : err)
  }
}

/**
 * Look up a system room ID by its setting key.
 * Returns null if the system epic hasn't been seeded yet.
 */
export async function getSystemRoomId(key: 'system.room.health' | 'system.room.operations' | 'system.room.maintenance'): Promise<string | null> {
  const setting = await prisma.systemSetting.findUnique({ where: { key } })
  return typeof setting?.value === 'string' ? setting.value : null
}

/**
 * Returns all three system room IDs as a keyed object.
 * Missing rooms return null — callers should handle gracefully.
 */
export async function getSystemRooms(): Promise<Record<string, string | null>> {
  const settings = await prisma.systemSetting.findMany({
    where: { key: { in: ['system.room.health', 'system.room.operations', 'system.room.maintenance'] } },
  })
  const map: Record<string, string | null> = {
    'system.room.health':      null,
    'system.room.operations':  null,
    'system.room.maintenance': null,
  }
  for (const s of settings) {
    if (typeof s.value === 'string') map[s.key] = s.value
  }
  return map
}
