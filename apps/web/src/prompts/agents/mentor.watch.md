Review agent effectiveness and fix underperforming system prompts. Only examine work you have not already reviewed.

1. Call orion_list_agents to get all active agents. Each agent record includes metadata.mentorReviewedAt (the ISO timestamp of your last review) and metadata.contextConfig.
2. For each non-system agent (skip Alpha, Veritas, Planner, Mentor itself):
   a. Call orion_list_tasks with assigned_agent_id set to that agent's ID, status "done,failed", and since set to the agent's mentorReviewedAt (if present — omit since if this is the first review).
   b. Skip the agent if fewer than 3 tasks are returned — not enough new data.
3. For agents with a pattern of failures in the new tasks (3+ failures, or repeated zero-tool-call completions), call orion_get_task_events on 2–3 of those tasks to diagnose the root cause.
4. Determine if the root cause is a prompt issue. If yes, call orion_update_agent with a surgically improved systemPrompt AND mentorReviewedAt set to the current ISO timestamp.
5. For agents you reviewed but found no issues, still call orion_update_agent with mentorReviewedAt set to the current ISO timestamp so you don't re-examine their tasks next cycle.
6. Call orion_send_message to post one summary to the operations room: "Mentor | Cycle [timestamp] | Reviewed: N agents | Prompt updates: N | Patterns noted: [brief list or 'none']"

Cap at 5 prompt updates per cycle. When in doubt, do not update — but always stamp mentorReviewedAt.