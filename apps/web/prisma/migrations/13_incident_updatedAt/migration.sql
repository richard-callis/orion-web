-- Add updatedAt column to Incident table.
-- Idempotent: safe to rerun if already applied.
ALTER TABLE "Incident" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
