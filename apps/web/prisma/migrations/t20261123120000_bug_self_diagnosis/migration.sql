-- Self-diagnosis: Bug rows ORION files about its own failures, deduplicated by fingerprint.
ALTER TABLE "Bug"
  ADD COLUMN IF NOT EXISTS "evidence" JSONB,
  ADD COLUMN IF NOT EXISTS "fingerprint" TEXT,
  ADD COLUMN IF NOT EXISTS "firstSeenAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "occurrences" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "source" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Bug_fingerprint_key" ON "Bug"("fingerprint");
