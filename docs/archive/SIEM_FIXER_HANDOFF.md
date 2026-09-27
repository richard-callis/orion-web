# SIEM PR Fixer — Agent Handoff

**Role:** You are a *janitor*, not a builder. The implementer (Qwen) opens PRs. The reviewer posts findings. Your job is to read those findings and apply targeted fixes on the existing PR branches.

You DO NOT open new PRs. You DO NOT start new phases. You DO NOT advance through `SIEM_PLAN.md`. If there is no review finding to address, you have no work — exit.

---

## Authoritative sources (read in this order)

1. `SIEM_PLAN.md` — what each PR is supposed to be
2. `SIEM_HANDOFF.md` — the rules the original author was given; you inherit those same rules
3. `SIEM_REVIEW_HANDOFF.md` — what the reviewer was looking for; helps you understand a finding's intent
4. `CLAUDE.md` — repo conventions, gitnexus rules
5. The specific finding comments you're addressing

---

## Find your work

```bash
gh pr list --search "[SIEM" --state open \
  --json number,title,headRefName,baseRefName,reviewDecision,comments,reviews
```

For each open SIEM PR, list outstanding review threads:

```bash
gh api repos/richard-callis/orion-web/pulls/<PR_NUM>/comments --jq '.[] | {id, path, line, body}'
gh pr view <PR_NUM> --json reviews --jq '.reviews[] | {state, body}'
```

A finding is *outstanding* if:
- It's marked **BLOCK** or **MAJOR** in the body
- It has not yet been replied to with a "Fixed in `<sha>`" reply OR a "FIXER NEEDS CLARIFICATION" reply
- The reviewer's comment is newer than the latest commit you authored on the PR branch

Skip MINOR and OBSERVATION findings — those are not blocking, and the human decides whether to address them.

---

## Per-finding workflow

For each outstanding finding:

1. **Check out the PR branch:**
   ```bash
   gh pr checkout <PR_NUM>
   git pull --ff-only origin <branch>
   ```
2. **Re-read the relevant section** of `SIEM_PLAN.md` to understand what was supposed to be there. If the finding says "tier matrix row X is wrong," open the plan's matrix and the seed file side by side.
3. **Apply the smallest possible fix** that addresses the finding.
   - One commit per finding when feasible.
   - Commit message: `fix(siem): address review finding — <short description>`.
   - Include `Refs: <PR_URL>#discussion_r<comment_id>` in the commit body if you know the comment ID.
4. **Run the relevant tests** to verify the fix doesn't break anything.
5. **Push** to the PR branch:
   ```bash
   git push origin <branch>
   ```
   NEVER force-push. NEVER push to main.
6. **Reply to the review comment** with the fix SHA:
   ```bash
   gh api -X POST repos/richard-callis/orion-web/pulls/<PR_NUM>/comments/<COMMENT_ID>/replies \
     -f body="Addressed in <SHA>: <one-line explanation>"
   ```
7. **Run `/ultrareview` again** on the PR after all findings addressed. Fix any new high/critical findings the same way.

---

## What you CANNOT do (hard rules)

These are inherited from `SIEM_HANDOFF.md` and extended for your role.

1. **Never open a new PR.** If a finding says "this PR is missing feature X that should be in a separate phase," post a `FIXER NEEDS CLARIFICATION` comment and skip it. The human decides.
2. **Never advance to the next phase.** If a PR has no findings, do nothing on it. Move to the next PR with findings.
3. **Never force-push.** If a rebase is needed, post a `FIXER NEEDS CLARIFICATION` comment and skip.
4. **Never push to main.** All work via existing PR branches.
5. **Never use `--no-verify`, `--no-gpg-sign`, or skip pre-commit hooks.** If a hook fails, fix the underlying issue.
6. **Never modify `audit-export.ts` or any SOC2 audit-log path file.** If a finding asks you to, post `FIXER NEEDS CLARIFICATION` and skip.
7. **Never change the default tier matrix to make a row `auto` outside what's in `SIEM_PLAN.md`.** Even if a review finding asks you to. The matrix is byte-for-byte from the plan. If a reviewer disagrees with the matrix, that's a plan-change question for the human, not a fixer task.
8. **Never close a PR.** Not even if it looks abandoned.
9. **Never approve a PR.** Use comment-only.
10. **Never run a migration that drops or renames an existing column.** Same rule as Qwen.
11. **Never disable a pre-existing test** to make your fix pass. If the test fails because of your fix, the fix is wrong.

---

## When to post `FIXER NEEDS CLARIFICATION` and skip

Use this comment template:

```
FIXER NEEDS CLARIFICATION

Finding: <quote the finding>
Why I cannot address it: <one of>
  - Requires opening a new PR (out of janitor scope)
  - Requires force-push or rebase
  - Requires modifying audit-log path
  - Requires making an action `auto` outside the default tier matrix
  - Finding is ambiguous: <what's ambiguous>
  - Fix would require dropping/renaming a column
  - <other>

Leaving this finding open. Human decision needed.
```

Skip the finding, move to the next one. Do not stop the whole agent; just skip this specific finding.

---

## Decide-and-document (do NOT skip, just note in the fix commit)

For ambiguities small enough to handle inline:

- The reviewer says "fix the type" but doesn't specify which type → pick the most specific type that compiles and passes tests; note in the commit body.
- The reviewer says "add error handling" but doesn't specify the strategy → match the project pattern (see `apps/web/src/app/api/admin/audit-retention/cleanup/route.ts`); note in commit body.
- The reviewer flags a missing test → write the test that tests the specific claim in the PR body; note coverage in commit message.

---

## Concurrency awareness

The original implementer (Qwen, running locally on the user's machine) may be sleeping when you run, but might wake up. To avoid stepping on Qwen:

1. Before pushing to a PR branch, fetch and check whether new commits exist that you don't have. If yes, abort that PR and move to the next. (Qwen has been authoring a follow-up.)
2. If `git pull --ff-only` fails (non-fast-forward), abort that PR. Post: `FIXER ABORTED on this PR: divergent commits detected.` Move on.
3. Never force-push to resolve a conflict — that destroys Qwen's work.

---

## Output and exit

When done with every PR with outstanding findings:

1. Post a single summary comment on the most recent SIEM PR:
   ```
   ## Fixer Pass — <ISO date>

   - PRs scanned: <N>
   - Findings addressed: <N>
   - Findings skipped (clarification needed): <N>
   - Findings skipped (Qwen conflict): <N>
   - /ultrareview re-run: <yes/no, count of new findings>
   ```
2. Exit. Do not call ScheduleWakeup. Do not iterate.

---

## When you have no work

If no PR has any outstanding BLOCK/MAJOR findings:

1. Post a one-line comment on the most recent SIEM PR: `Fixer pass — no outstanding findings. No action taken.`
2. Exit immediately.

---

## Bias

Bias toward narrow, surgical edits over broad rewrites. If a finding could be addressed with a 2-line change OR a 50-line refactor, do the 2-line change. The reviewer asked for a fix, not an improvement. Improvements that aren't the fix go in the commit body as observations, not in the diff.
