-- Migration: add incidentId link to ChatMessage
--
-- Allows the correlator to explicitly associate chat messages with an
-- incident, enabling the UI to look up incident chat by the typed
-- field rather than parsing a text substring from the message body.
--
-- NOTE: the Prisma model `ChatMessage` is mapped to physical table
-- `chat_messages` via @@map. Always use the snake_case table name here.

DO $migrate$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chat_messages' AND column_name = 'incidentId'
  ) THEN
    ALTER TABLE "chat_messages" ADD COLUMN "incidentId" TEXT;

    ALTER TABLE "chat_messages"
      ADD CONSTRAINT "chat_messages_incidentId_fkey"
      FOREIGN KEY ("incidentId") REFERENCES "Incident"("id")
      ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS "chat_messages_incidentId_idx"
      ON "chat_messages"("incidentId");
  END IF;
END;
$migrate$;
