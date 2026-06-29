CREATE TYPE "ContainmentStatus" AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE "ContainmentRequest" (
  "id"            TEXT NOT NULL DEFAULT gen_random_uuid(),
  "incidentId"    TEXT NOT NULL,
  "action"        TEXT NOT NULL,
  "justification" TEXT NOT NULL,
  "status"        "ContainmentStatus" NOT NULL DEFAULT 'pending',
  "requestedBy"   TEXT NOT NULL,
  "reviewedBy"    TEXT,
  "reviewedAt"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContainmentRequest_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ContainmentRequest" ADD CONSTRAINT "ContainmentRequest_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ContainmentRequest_incidentId_idx" ON "ContainmentRequest"("incidentId");
CREATE INDEX "ContainmentRequest_status_idx" ON "ContainmentRequest"("status");
