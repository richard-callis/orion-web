/**
 * Server-side in-memory typing state for chat rooms.
 *
 * Tracks which agents are currently generating a reply so the frontend can
 * show a "{Name} is typing..." indicator. Module-level singleton — safe for
 * a single Node.js process (Next.js production build).
 */

const typingMap = new Map<string, Set<string>>() // roomId → Set<agentName>

export function setTyping(roomId: string, agentName: string): void {
  if (!typingMap.has(roomId)) typingMap.set(roomId, new Set())
  typingMap.get(roomId)!.add(agentName)
}

export function clearTyping(roomId: string, agentName: string): void {
  typingMap.get(roomId)?.delete(agentName)
}

export function getTyping(roomId: string): string[] {
  return Array.from(typingMap.get(roomId) ?? [])
}
