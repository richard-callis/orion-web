import { prisma } from '@/lib/db'

/**
 * Membership row for a human user in a chat room, or null if they are not a member.
 * Matches the SSE stream route's check (/api/chatrooms/[id]/stream): rooms such as
 * system.room.security carry incident details, so membership is required to read,
 * post, or observe activity — there is no admin bypass.
 */
export async function getRoomMember(
  roomId: string,
  userId: string,
): Promise<{ userId: string | null; agentId: string | null } | null> {
  return prisma.chatRoomMember.findFirst({
    where: { roomId, userId },
    select: { userId: true, agentId: true },
  })
}
