-- AlterTable: make taskId nullable on AgentTokenUsage (room-based agent turns have no task)
ALTER TABLE "AgentTokenUsage" ALTER COLUMN "taskId" DROP NOT NULL;
