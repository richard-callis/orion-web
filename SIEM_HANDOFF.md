# SIEM Implementation — Handoff to Claude Code (Qwen 3.6)

**Role:** You are implementing the SIEM completion for Orion-Web. You are running as Claude Code with Qwen 3.6. A human collaborator and a separate Opus reviewer will check your work.

**Authoritative sources (read these first, in order):**
1. `SIEM_PLAN.md` — your implementation playbook. File paths, schemas, tier matrix, success criteria.
2. `SIEM_ULTRAPLAN_BRIEF.md` — the design intent behind the plan. Read this so you understand *why*, not just *what*.
3. `CLAUDE.md` — repo conventions, gitnexus rules, worktree workflow.
4. `PROJECT_SUMMARY.md` — SOC2 work already done; your changes must integrate with it.

---

## Non-negotiable rules

These are NOT suggestions.

1. **Follow `SIEM_PLAN.md` phase order**, but DO NOT wait between phases. PRs are the gate (humans approve merges to main); your job is to keep stacking branches and opening PRs.
2. **Stack PRs.** Phase 0 branches off `main`. Phase 1 worktrees A/B/C branch off `feat/siem-foundation` (the P0 branch), not main. Each later phase branches off the most recent unmerged dependency. When a base PR merges, GitHub re-targets the stacked PRs to main automatically.
3. **One PR per phase or per worktree.** Never bundle phases.
4. **Document deviations IN THE PR; do not stop for them.** If you change a field name, add a small helper, or pick a reasonable interpretation where the plan is ambiguous, write it in PR body section 4 ("Deviations") and proceed. The reviewer will surface it if it's wrong.
5. **The default tier matrix in `SIEM_PLAN.md` is security-critical and exempt from rule 4.** Implement it byte-for-byte. If you find a case the matrix doesn't cover, default to `approve`, flag it in the PR, and proceed. Never default a new action to `auto`.
6. **Run `gitnexus_impact` before modifying any existing function or model.** Report blast radius in the PR description. If it returns CRITICAL, document the impact + your plan, then proceed.
7. **Never use `--no-verify`, `--no-gpg-sign`, or skip pre-commit hooks.** Fix the underlying issue and create a new commit.
8. **Never run destructive git operations** (`reset --hard`, `push --force` *to main*, `branch -D` *on shared branches*, `clean -f`). Force-pushes to your own feature branches during rebase are fine.
9. **Never push directly to `main`.** All work via PR. (You physically can't with branch protection on, but state it anyway.)
10. **Never modify `audit-export.ts` or the SOC2 audit-log path.** If you think you need to, document the integration point in your PR and route around it.

---

## Outstanding-review-comment priority

**Before starting any new phase**, check your open PRs for unresolved review comments:

```bash
gh pr list --author @me --state open --json number,title \
  | jq -r '.[] | .number' \
  | xargs -I{} sh -c 'gh pr view {} --json comments,reviews --jq ".comments + .reviews" | grep -q "BLOCK\|MAJOR" && echo "PR {} needs fixes"'
```

If any PR has a review comment marked `BLOCK` or `MAJOR` that you have not yet addressed in a subsequent commit:

1. Switch to that PR's branch (`git fetch && git checkout <branch>`).
2. Address each finding in order, one commit per finding when feasible.
3. Push to the PR branch — never force-push.
4. Reply to each review comment with the SHA of the commit that addresses it.
5. Run `/ultrareview` again on the updated PR.
6. After the PR has no outstanding `BLOCK`/`MAJOR` comments, return to the next phase in the plan.

Treat outstanding review comments on your own PRs as HIGHER priority than advancing to the next phase.

## Workflow per phase

For each phase (P0 → A/B/C → P2 → P3 → P4/P5 → P6), execute end-to-end then immediately start the next phase:

1. **Create a worktree** using `./orion-worktree.sh create feat/siem-<phase> [base-branch]`. The base branch is the most recent unmerged dependency (e.g. `feat/siem-foundation` for Worktrees A/B/C). For P0, base is `main`.
2. **Read the relevant section of `SIEM_PLAN.md`.** Quote the bullet you're implementing in your TaskCreate description.
3. **TaskCreate** a checklist matching the file-level bullets. Mark `in_progress` when you start, `completed` when the test passes.
4. **Implement.** Match existing code conventions (TypeScript strict, Zod validation at boundaries, error handling like `apps/web/src/app/api/admin/audit-retention/cleanup/route.ts`).
5. **Test.** Every new function: unit test. Every new route: integration test. See "Test plan" in `SIEM_PLAN.md`.
6. **Run `gitnexus_detect_changes()` before committing** to verify scope.
7. **Push branch + open PR** with title `[SIEM <phase-id>] <short description>`. Body:
   - Which `SIEM_PLAN.md` section this implements
   - Base branch (which PR/branch this stacks on)
   - `gitnexus_impact` summary
   - Test results
   - Deviations from the plan + reasoning
8. **Run `/ultrareview` on the PR.** Fix any high/critical findings in a follow-up commit on the same branch.
9. **Do not self-merge. Do not wait either** — immediately move to the next phase, branching off this PR's branch.
10. **If a dependency PR gets review comments later**, you'll be notified. Rebase your stacked branches off the updated base before continuing the chain.

---

## Things you'll be tempted to do that you must NOT do

- **Refactor existing files "while you're in there."** If a file is messy but works, leave it. Scope creep makes review impossible.
- **Add "small improvements" to the plan.** If you think the plan is wrong, raise it. Don't quietly fix it.
- **Combine migrations.** Each phase's schema changes get their own Prisma migration file. Don't merge them.
- **Mock external services in integration tests.** Use the existing fixtures pattern from SOC2 smoke tests.
- **Touch the audit log infrastructure (`audit-export.ts`).** Your work *integrates* with it; you don't modify it. If you think you need to, stop and ask.
- **Implement Phase 6 features earlier than Phase 6.** Retention/TTL is the last step, not the first.
- **Cut the test plan.** "I'll add tests later" is a fail. The test goes in the same PR as the code.

---

## Phase 0 specifics (do this first)

Phase 0 is the load-bearing PR. After opening it, immediately start Worktrees A/B/C branched off P0 — do not wait for it to merge.

1. Start the worktree: `./orion-worktree.sh create feat/siem-foundation`.
2. **P0.1 — Schema** (`apps/web/prisma/schema.prisma`):
   - Modify `SecurityEvent` as plan specifies — add `incidentId String?`, `firstSeen`, `lastSeen`. Keep existing fields.
   - Add the six new models exactly as written in the plan.
   - Generate migration: `npx prisma migrate dev --name siem_foundation_schema`.
   - **Do not** run `prisma db push` against any shared DB. Local dev DB only.
3. **P0.2 — System room** (`apps/web/src/lib/seed-system-epic.ts`):
   - Add `Security` feature.
   - Add `system.room.security` ChatRoom with members `['Warden']`.
   - The Warden Agent record does not exist yet — that's Phase 4. The room seed should reference the agent by name; the agent-room link gets created when Warden is seeded later.
4. **P0.3 — Action policy seed** (`apps/web/src/lib/seed-action-policies.ts`):
   - Copy the default tier matrix from `SIEM_PLAN.md` byte-for-byte.
   - Include the `__panic_mode__` row with `defaultTier='auto'` (disabled by default).
   - **This file is security-critical.** Match the plan exactly.
5. **P0.4 — Shared types** (`apps/web/src/lib/security/types.ts`):
   - Export the four interfaces named in the plan.
   - Use Zod schemas for runtime validation, TypeScript types via `z.infer`.

**P0 success criteria:**
- `npx prisma migrate dev` succeeds clean.
- `npm test` passes in `apps/web`.
- `gitnexus_detect_changes()` shows changes scoped to schema + seed files + types + their tests.
- No changes outside `apps/web/prisma/`, `apps/web/src/lib/security/`, and `apps/web/src/lib/seed-*.ts`.

After opening the P0 PR + running `/ultrareview`, immediately create the next worktree branched off `feat/siem-foundation` and start Worktree A.

---

## When to STOP and post BLOCKED (do not proceed)

These are the only conditions that justify halting the loop. Everything else: decide, document in the PR body, proceed.

- A migration would DROP or RENAME a column on an existing table. → BLOCK. Document in PR. Migrations are forever; only the human can authorize.
- `audit-export.ts` or the SOC2 audit-log path needs changing to make your code work. → BLOCK. Route around it or open a "BLOCKED" PR.
- A pre-commit hook fails and you can't fix it without `--no-verify`. → BLOCK. Posting --no-verify is never the answer.
- A test that existed before your change is failing because of your change AND you cannot identify the root cause within one debugging cycle. → BLOCK. Do not disable the test.
- You would need to write code that auto-executes an action not in the default tier matrix. → BLOCK. The answer is always no.
- A new top-level npm dependency would need to be added. → Decide if it's truly necessary; if yes, document why in the PR and add it. If you're unsure, BLOCK.

## When to decide and document (do not stop)

- The plan says X but the existing code has Y. → Pick the option that better matches the plan's *intent*; explain your call in PR Deviations section.
- A field name in the plan conflicts with a Prisma reserved word. → Rename minimally (e.g. add `_` suffix), document.
- A schema field type is ambiguous. → Pick the most specific type (e.g. `Decimal` over `Float` for severity if scoring is integer-only). Document.
- `gitnexus_impact` returns HIGH (not CRITICAL). → Document the blast radius in the PR body and proceed.
- An ESLint rule wants a small refactor in a file you're already touching. → Apply the suggested fix only to the lines you changed, not surrounding lines.

---

## Commit + PR conventions

- Match the commit message style in `git log` for this repo (read it before committing).
- Co-author line: `Co-Authored-By: Claude Code (Qwen 3.6) <noreply@anthropic.com>`
- Atomic commits within a PR — one logical change per commit.
- PR title format: `[SIEM <phase-id>] <short description>` (e.g. `[SIEM P0.1] Schema redesign`).

---

## When you finish a phase

1. Mark all tasks completed.
2. Open the PR (see Workflow per phase above).
3. Run `/ultrareview` against the PR.
4. Fix any high/critical findings.
5. **Immediately create the next worktree, branched off this PR's branch, and start the next phase.** Do not wait.
6. The human will review and merge PRs at their own pace. When a base PR merges, your stacked PRs auto-retarget to main.

---

## When you don't know what to do

The plan is the source of truth. For most ambiguities: decide on the option closest to the plan's *intent*, document the call in your PR's Deviations section, and proceed. The reviewer will surface anything that's wrong; you don't need to pre-empt them.

Only stop for the items in the "When to STOP and post BLOCKED" section. Everything else: keep shipping.
