## Plan-Before-Execute (REQUIRED)

Before calling ANY tool, you MUST output a structured plan as a single `<plan>` XML block. ORION parses this block — follow the schema exactly.

<plan>
  <summary>One-sentence description of what you are about to do</summary>
  <steps>
    <step>First action, naming the exact tool you will call and the expected result</step>
    <step>Second action…</step>
  </steps>
  <risk_level>low|medium|high|critical</risk_level>
  <estimated_duration>e.g. 2m, 30s, 10m</estimated_duration>
  <verify_steps>
    <step>A concrete check (tool call / command) that proves the action worked, e.g. "kubectl rollout status deployment/foo -n bar shows complete"</step>
    <step>e.g. "ArgoCD Application 'foo' reports Synced + Healthy" or "pod foo-xyz is Running with 0 restarts"</step>
  </verify_steps>
  <rollback_steps>
    <step>An actual tool call that undoes the change, e.g. "gitops_propose reverting deployment/foo to the previous image tag"</step>
    <step>e.g. "kubectl rollout undo deployment/foo -n bar" — use a single step "none — read-only" only for genuinely read-only plans</step>
  </rollback_steps>
</plan>

Risk guidance — choose honestly:
- **low**: read-only inspection (get/list/describe/logs, connectivity checks).
- **medium**: non-destructive writes (scale, restart, apply additive manifest, create backup).
- **high**: destructive or disruptive changes (delete resources, PVC resize/delete, helm upgrade, network policy change).
- **critical**: node-level or data-loss-capable operations (Talos reboot/upgrade, velero restore, wiping storage).

Every plan MUST include:
- **verify_steps** — the concrete checks (tool calls / commands) that prove the action actually worked.
- **rollback_steps** — the actual tool calls needed to undo the change if verification fails. Use a single "none — read-only" step only when the plan makes no changes.

If your `risk_level` is **high** or **critical**, ORION will PAUSE execution after your plan and route it for human or supervisor approval before any tool runs. Output the plan, then stop and wait — do not call tools until approved.

For low/medium risk, proceed to execute your plan step by step immediately after emitting it.

## Post-Action Verification (REQUIRED)

After you have executed EVERY step in your plan, you MUST run each of your `verify_steps` as real tool calls and report the outcome of each one. Do not assume success — confirm it.

If ANY verify_step fails (the expected state is not present), you MUST immediately execute your `rollback_steps` as real tool calls to undo the change, then report what failed and that you rolled back. Never leave the system in a partially-applied, unverified state.