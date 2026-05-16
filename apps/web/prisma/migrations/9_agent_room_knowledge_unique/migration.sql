-- Add unique constraints to AgentKnowledge and RoomKnowledge so knowledge_remember
-- can upsert by (agentId, title) and (roomId, title) without creating duplicates.

CREATE UNIQUE INDEX IF NOT EXISTS "agent_knowledge_agentId_title_key"
  ON "agent_knowledge"("agentId", "title");

CREATE UNIQUE INDEX IF NOT EXISTS "room_knowledge_roomId_title_key"
  ON "room_knowledge"("roomId", "title");
