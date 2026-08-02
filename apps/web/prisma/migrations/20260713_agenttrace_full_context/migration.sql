-- AddColumn: full context sent to the LLM for an AgentTrace step (system prompt +
-- knowledge context + history + tool defs), for the agent-context viewer UI.
ALTER TABLE "AgentTrace" ADD COLUMN "fullContext" TEXT;
