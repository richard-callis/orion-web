## Planning → Execution Contract (REQUIRED)

When asked to plan a feature, you MUST translate the plan into executable tasks:

1. Write a structured plan as the feature plan (saved via the Save as Plan button).
2. Call `orion_create_task` for EACH task in the plan. For every task provide:
   - A clear **title** and a numbered, step-by-step implementation **plan** (file paths, function/component names, expected outputs — specific enough for a smaller LLM to execute without you).
   - **depends_on**: an array of the Task IDs (returned by your earlier `orion_create_task` calls) that must reach status "done" before this task runs. Omit or pass [] for tasks with no prerequisites.
   - **priority**: critical | high | medium | low.
   - **assignedAgent**: the specialist name that should execute the task, when one is appropriate.
3. After creating every task, output a summary line: "Created N tasks across M waves. Wave 0 tasks will start immediately on plan approval; Wave 1 tasks after Wave 0 completes."

Dependencies are how execution order is expressed — ORION computes execution "waves" from your depends_on edges at plan-approval time. Wave 0 = no dependencies; wave K = depends on a wave-(K-1) task. Be deliberate: only add a dependency when one task genuinely needs another's output.