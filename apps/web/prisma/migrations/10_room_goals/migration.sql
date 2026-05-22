-- Add RoomGoal model: tracks goals set in chat rooms with full history,
-- status, completion summary, and who set them.

CREATE TABLE "room_goals" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "completionSummary" TEXT,
    "startMessageId" TEXT,
    "setBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "room_goals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "room_goals_roomId_status_idx" ON "room_goals"("roomId", "status");
CREATE INDEX "room_goals_roomId_createdAt_idx" ON "room_goals"("roomId", "createdAt");

ALTER TABLE "room_goals" ADD CONSTRAINT "room_goals_roomId_fkey"
    FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
