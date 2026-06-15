-- Add per-user ownership to Note (SOC2 note scoping).
-- createdBy is nullable: NULL = shared/system note (globally visible).
ALTER TABLE "Note" ADD COLUMN "createdBy" TEXT;

ALTER TABLE "Note" ADD CONSTRAINT "Note_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
