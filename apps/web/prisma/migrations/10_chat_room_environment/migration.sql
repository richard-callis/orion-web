-- Migration: pin chat rooms to an environment
-- environmentId: the Environment this room's agents operate against.
-- Auto-selected when exactly one environment exists; when null, agents are
-- instructed to ask the user for the environment before env-scoped actions.

ALTER TABLE "chat_rooms" ADD COLUMN IF NOT EXISTS "environmentId" TEXT;

DO $$ BEGIN
  ALTER TABLE "chat_rooms"
    ADD CONSTRAINT "chat_rooms_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "Environment"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "chat_rooms_environmentId_idx" ON "chat_rooms"("environmentId");
