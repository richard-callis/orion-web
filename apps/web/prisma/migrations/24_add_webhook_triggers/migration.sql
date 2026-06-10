-- Migration: 24_add_webhook_triggers
-- Adds inbound webhook triggers that create tasks from external events.

CREATE TABLE "WebhookTrigger" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "agentId"     TEXT NOT NULL,
    "secret"      TEXT NOT NULL,
    "source"      TEXT NOT NULL DEFAULT 'custom',
    "taskTitle"   TEXT NOT NULL,
    "taskDesc"    TEXT,
    "enabled"     BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" TIMESTAMP(3),
    "fireCount"   INTEGER NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookTrigger_pkey" PRIMARY KEY ("id")
);

-- Index for agent-based lookups
CREATE INDEX "WebhookTrigger_agentId_idx" ON "WebhookTrigger"("agentId");

-- Foreign key to Agent
ALTER TABLE "WebhookTrigger" ADD CONSTRAINT "WebhookTrigger_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
