-- Migration: Task dependencies + execution wave
--
-- Adds two columns to the Task table to support the integrated
-- planning-to-execution loop:
--   dependsOn — Task IDs that must reach status 'done' before this task runs.
--               Prisma scalar string array; the worker checks dependency
--               satisfaction in-memory because Postgres can't relationally
--               filter "all elements of this array are in a done-set".
--   wave      — execution wave computed at plan-approval time (0 = no deps,
--               1 = depends on a wave-0 task, etc.). Drives poll ordering so
--               earlier waves run first.

ALTER TABLE "Task" ADD COLUMN "dependsOn" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Task" ADD COLUMN "wave" INTEGER;
