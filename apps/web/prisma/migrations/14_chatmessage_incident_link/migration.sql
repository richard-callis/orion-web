-- Migration: add incidentId link to ChatMessage
--
-- Allows the correlator to explicitly associate chat messages with an
-- incident, enabling the UI to look up incident chat by the typed
-- field rather than parsing a text substring from the message body.

-- Check if the column already exists (idempotent for safe re-runs)
DO $migrate$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ChatMessage' AND column_name = 'incidentId'
  ) THEN
    ALTER TABLE "ChatMessage" ADD COLUMN "incidentId" TEXT;
    -- Add FK constraint
    ALTER TABLE "ChatMessage"
      ADD CONSTRAINT "ChatMessage_incidentId_fkey"
      FOREIGN KEY ("incidentId") REFERENCES "Incident"("id")
      ON DELETE SET NULL;
    -- Add index for fast lookups
    CREATE INDEX IF NOT EXISTS "ChatMessage_incidentId_idx" ON "ChatMessage"("incidentId");
  END IF;
END;
$migrate$;
