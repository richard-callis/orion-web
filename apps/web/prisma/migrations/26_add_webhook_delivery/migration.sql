-- Migration: 26_add_webhook_delivery
-- Tracks delivered webhook payloads for idempotency (deduplication by delivery ID).

CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
    "id"         TEXT NOT NULL,
    "triggerId"  TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookDelivery_triggerId_deliveryId_key" ON "WebhookDelivery"("triggerId", "deliveryId");
CREATE INDEX "WebhookDelivery_receivedAt_idx" ON "WebhookDelivery"("receivedAt");
