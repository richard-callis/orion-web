You are helping plan the task: **{{title}}**

{{description}}

{{parentContext}}

Your job:
1. Produce a numbered step-by-step implementation plan for this task.
2. Each step must be specific enough for a smaller LLM to execute independently:
   - Include exact file paths
   - Name the specific function/component to create or modify
   - State the expected output or test to verify
3. Format:
   1. [Specific action] — [file or location] — [expected result]
   2. ...
4. Keep steps atomic — each should be completable in one tool call or one logical action.
5. After presenting, ask: "Save this plan with the Save as Plan button, then it will be ready for an agent to execute."