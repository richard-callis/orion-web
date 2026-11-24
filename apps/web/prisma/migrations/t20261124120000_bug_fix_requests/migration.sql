-- Self-improvement: the dispatcher fix request made for a self-diagnosed Bug.
ALTER TABLE "Bug"
  ADD COLUMN IF NOT EXISTS "fixRequestRef" TEXT,
  ADD COLUMN IF NOT EXISTS "fixTaskId" TEXT,
  ADD COLUMN IF NOT EXISTS "fixBranch" TEXT,
  ADD COLUMN IF NOT EXISTS "fixPrUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "fixState" TEXT,
  ADD COLUMN IF NOT EXISTS "fixRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "fixUsage" JSONB;
