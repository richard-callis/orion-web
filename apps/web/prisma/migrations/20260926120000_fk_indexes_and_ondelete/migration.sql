-- Hot-path foreign-key indexes, createdAt indexes for retention purges, and
-- explicit ON DELETE rules for relations that previously defaulted to
-- RESTRICT (deleting a Conversation / Agent / EvalSuite / Task failed with an
-- FK error once dependent rows existed).
--
-- Written by hand rather than taken verbatim from `prisma migrate diff`:
--   * every statement is idempotent (IF NOT EXISTS / IF EXISTS)
--   * FK constraints are located by column, not by name — some production
--     databases carry lower-cased constraint names from early hand migrations
--     (see 5_ring_leader_hooks_evals), so a plain DROP CONSTRAINT "X_fkey"
--     could fail there.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── ON DELETE rules ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.orion_replace_fk(
  tbl TEXT, col TEXT, ref_tbl TEXT, fk_name TEXT, on_delete TEXT
) RETURNS void AS $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.contype = 'f'
      AND con.conrelid = format('%I', tbl)::regclass
      AND array_length(con.conkey, 1) = 1
      AND att.attname = col
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, c.conname);
  END LOOP;
  EXECUTE format(
    'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I("id") ON DELETE %s ON UPDATE CASCADE',
    tbl, fk_name, col, ref_tbl, on_delete);
END;
$$ LANGUAGE plpgsql;

SELECT pg_temp.orion_replace_fk('ClaudeInvocation',  'conversationId', 'Conversation', 'ClaudeInvocation_conversationId_fkey', 'CASCADE');
SELECT pg_temp.orion_replace_fk('FederatedDispatch', 'taskId',         'Task',         'FederatedDispatch_taskId_fkey',       'CASCADE');
SELECT pg_temp.orion_replace_fk('EvalRun',           'suiteId',        'EvalSuite',    'EvalRun_suiteId_fkey',                'CASCADE');
SELECT pg_temp.orion_replace_fk('EvalRun',           'agentId',        'Agent',        'EvalRun_agentId_fkey',                'CASCADE');
SELECT pg_temp.orion_replace_fk('EvalCaseResult',    'caseId',         'EvalCase',     'EvalCaseResult_caseId_fkey',          'CASCADE');
SELECT pg_temp.orion_replace_fk('ScheduledTask',     'agentId',        'Agent',        'ScheduledTask_agentId_fkey',          'CASCADE');

-- Optional relations (AgentMessage.agent, Task.agent, NebulaInstance.novaDefinition,
-- ToolExecution.environment, EvalSuite.agent) are now declared onDelete: SetNull
-- explicitly in schema.prisma. Prisma already created them as ON DELETE SET NULL
-- (its default for optional relations), so no SQL change is needed for them.

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX IF NOT EXISTS "ClaudeInvocation_conversationId_idx" ON "ClaudeInvocation"("conversationId");
CREATE INDEX IF NOT EXISTS "ClaudeInvocation_createdAt_idx" ON "ClaudeInvocation"("createdAt");
CREATE INDEX IF NOT EXISTS "AgentTokenUsage_recordedAt_idx" ON "AgentTokenUsage"("recordedAt");
CREATE INDEX IF NOT EXISTS "AgentMessage_channel_createdAt_idx" ON "AgentMessage"("channel", "createdAt");
CREATE INDEX IF NOT EXISTS "AgentMessage_agentId_idx" ON "AgentMessage"("agentId");
CREATE INDEX IF NOT EXISTS "AgentMessage_createdAt_idx" ON "AgentMessage"("createdAt");
CREATE INDEX IF NOT EXISTS "Task_featureId_idx" ON "Task"("featureId");
CREATE INDEX IF NOT EXISTS "Task_assignedAgent_idx" ON "Task"("assignedAgent");
CREATE INDEX IF NOT EXISTS "TaskEvent_taskId_createdAt_idx" ON "TaskEvent"("taskId", "createdAt");
CREATE INDEX IF NOT EXISTS "TaskEvent_createdAt_idx" ON "TaskEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "api_keys_userId_idx" ON "api_keys"("userId");
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");
CREATE INDEX IF NOT EXISTS "DnsRecord_domainId_idx" ON "DnsRecord"("domainId");
CREATE INDEX IF NOT EXISTS "IngressPoint_domainId_idx" ON "IngressPoint"("domainId");
CREATE INDEX IF NOT EXISTS "IngressPoint_environmentId_idx" ON "IngressPoint"("environmentId");
CREATE INDEX IF NOT EXISTS "NovaDeployment_environmentId_idx" ON "NovaDeployment"("environmentId");
CREATE INDEX IF NOT EXISTS "NovaDeployment_agentId_idx" ON "NovaDeployment"("agentId");
CREATE INDEX IF NOT EXISTS "chat_rooms_taskId_idx" ON "chat_rooms"("taskId");
CREATE INDEX IF NOT EXISTS "chat_rooms_epicId_idx" ON "chat_rooms"("epicId");
CREATE INDEX IF NOT EXISTS "chat_messages_agentId_idx" ON "chat_messages"("agentId");
CREATE INDEX IF NOT EXISTS "chat_messages_userId_idx" ON "chat_messages"("userId");
CREATE INDEX IF NOT EXISTS "chat_messages_taskId_idx" ON "chat_messages"("taskId");
CREATE INDEX IF NOT EXISTS "VulnerabilityFinding_taskId_idx" ON "VulnerabilityFinding"("taskId");
CREATE INDEX IF NOT EXISTS "VulnerabilityFinding_scanId_idx" ON "VulnerabilityFinding"("scanId");
CREATE INDEX IF NOT EXISTS "HookExecutionLog_startedAt_idx" ON "HookExecutionLog"("startedAt");
CREATE INDEX IF NOT EXISTS "SkillExecutionLog_createdAt_idx" ON "SkillExecutionLog"("createdAt");
CREATE INDEX IF NOT EXISTS "InvestigationTimeline_createdAt_idx" ON "InvestigationTimeline"("createdAt");
CREATE INDEX IF NOT EXISTS "ToolExecution_environmentId_idx" ON "ToolExecution"("environmentId");
CREATE INDEX IF NOT EXISTS "ToolExecution_createdAt_idx" ON "ToolExecution"("createdAt");
CREATE INDEX IF NOT EXISTS "JobRun_startedAt_idx" ON "JobRun"("startedAt");
