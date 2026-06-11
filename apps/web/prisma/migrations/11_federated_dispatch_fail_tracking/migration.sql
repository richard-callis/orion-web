ALTER TABLE "FederatedDispatch" ADD COLUMN "lastPolledAt" TIMESTAMP(3);
ALTER TABLE "FederatedDispatch" ADD COLUMN "failCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "FederatedDispatch_status_idx" ON "FederatedDispatch"("status");
