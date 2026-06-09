/**
 * Completion rollup — when the last task of a feature reaches 'done', mark the
 * feature done and post a summary to its chat room; likewise roll an epic up to
 * 'done' when all its features are done.
 *
 * Invoked from the place a task transitions to 'done' (orion_close_task) so the
 * rollup runs regardless of whether the close came from an agent or a human.
 */
import type { PrismaClient } from '@prisma/client'

async function postRoomSummary(
  prisma: PrismaClient,
  where: { featureId: string } | { epicId: string },
  content: string
): Promise<void> {
  const room = await prisma.chatRoom.findFirst({ where, select: { id: true } })
  if (!room) return
  await prisma.chatMessage
    .create({ data: { roomId: room.id, senderType: 'system', content } })
    .catch(() => {})
}

export async function checkEpicCompletion(epicId: string, prisma: PrismaClient): Promise<void> {
  const epic = await prisma.epic.findUnique({
    where: { id: epicId },
    include: { features: { select: { status: true } } },
  })
  if (!epic) return
  const allDone = epic.features.length > 0 && epic.features.every(f => f.status === 'done')
  if (allDone && epic.status !== 'done') {
    await prisma.epic.update({ where: { id: epicId }, data: { status: 'done' } })
    await postRoomSummary(prisma, { epicId }, `✅ All features complete. Epic '${epic.title}' is done.`)
  }
}

export async function checkFeatureCompletion(featureId: string, prisma: PrismaClient): Promise<void> {
  const feature = await prisma.feature.findUnique({
    where: { id: featureId },
    include: { tasks: { select: { status: true } } },
  })
  if (!feature) return
  const allDone = feature.tasks.length > 0 && feature.tasks.every(t => t.status === 'done')
  if (allDone && feature.status !== 'done') {
    await prisma.feature.update({ where: { id: featureId }, data: { status: 'done' } })
    await postRoomSummary(
      prisma,
      { featureId },
      `✅ All tasks complete. Feature '${feature.title}' is done.`
    )
    await checkEpicCompletion(feature.epicId, prisma)
  }
}
