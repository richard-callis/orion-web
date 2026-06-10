-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "type"        TEXT NOT NULL,
    "webhookUrl"  TEXT NOT NULL,
    "events"      TEXT NOT NULL DEFAULT '["task_completed","task_failed"]',
    "agentFilter" TEXT,
    "enabled"     BOOLEAN NOT NULL DEFAULT true,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);
