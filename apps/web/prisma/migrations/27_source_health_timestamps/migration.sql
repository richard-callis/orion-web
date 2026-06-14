-- Add createdAt/updatedAt to SourceHealth (already exist in DB from earlier
-- migration, adding defaults so Prisma does not fail on insert).
ALTER TABLE "SourceHealth"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;
