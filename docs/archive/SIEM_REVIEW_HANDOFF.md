# SIEM PR Review — Agent Handoff

**Role:** You are an independent reviewer for the SIEM completion work in Orion-Web. The implementer (Claude Code running Qwen 3.6) has been opening stacked PRs autonomously per `SIEM_HANDOFF.md`. Your job is to review every open PR they've authored and post structured feedback.

You are NOT the implementer. Do not write code. Do not fix things yourself. Surface findings; the human will decide what to fix.

---

## Authoritative sources (read in this order)

1. `SIEM_PLAN.md` — what the implementation is supposed to be
2. `SIEM_ULTRAPLAN_BRIEF.md` — design intent behind the plan
3. `SIEM_HANDOFF.md` — the rules Qwen was given (you check that they were followed)
4. `CLAUDE.md` — repo conventions, gitnexus rules
5. `PROJECT_SUMMARY.md` — SOC2 work the SIEM must integrate with

---

## How to find the PRs

```bash
gh pr list --search "[SIEM" --state open --json number,title,headRefName,baseRefName,author
```

Order them by `[SIEM <phase-id>]` to get them in dependency order (P0.1 → P0.2 → P0.3 → P0.4 → A → B → C → P2 → P3 → P4 → P5 → P6). Review in that order — earlier PRs set context for later ones.

For each PR, read:
- The PR body (especially the Deviations section)
- The full diff: `gh pr diff <number>`
- The PR's own `/ultrareview` results if they were posted as comments

---

## Per-PR review checklist

Walk through this for EVERY PR. Score each item PASS / FAIL / N/A. Do not skip items.

### 1. Plan alignment
- [ ] PR title matches `[SIEM <phase-id>] <description>` format
- [ ] PR body cites the specific `SIEM_PLAN.md` section it implements
- [ ] Diff scope is limited to that phase — no drive-by changes to unrelated files
- [ ] Base branch correctly stacks on dependencies (P0 off main; A/B/C off P0; later phases off their deps)

### 2. Security-critical: the tier matrix (Phase 0 / P0.3)
This applies to whichever PR creates `seed-action-policies.ts`. Open `SIEM_PLAN.md` to the "Default tier matrix" table and diff it line-by-line against the seed file.

- [ ] Every row in the plan's matrix is present in the seed
- [ ] No row defaults to `auto` that wasn't `auto` in the plan
- [ ] No action type exists in the seed that's NOT in the plan
- [ ] `__panic_mode__` row exists with `defaultTier='auto'` (disabled by default)
- [ ] Target-pattern overrides match the plan (home subnet → approve; named-prod → escalate)

**If any of these fail: HARD BLOCK. This is the file most likely to cause a security incident.**

### 3. Schema integrity (Phase 0 / P0.1)
- [ ] All six new models exist with the fields the plan specifies
- [ ] `SecurityEvent` was modified, not replaced — existing fields kept
- [ ] Migration is forward-only, no DROP/RENAME on existing columns
- [ ] Indexes present on `(environmentId, createdAt)` and similar where queries need them
- [ ] No `prisma db push` artifacts (only `migrate dev` migrations)

### 4. Gateway write tools (Worktree A)
- [ ] All 4 tools added: `crowdsec_decision_create`, `crowdsec_decision_delete`, `wazuh_active_response`, `firewall_block` (or feature-flagged stub)
- [ ] Tests cover happy-path + error responses
- [ ] No tool can execute without the action-policy decision wrapper (i.e., tools are not callable directly from the action route)
- [ ] Timeouts present (AbortSignal.timeout pattern matches existing tools)

### 5. Ingestion (Worktree B)
- [ ] Webhook routes for CrowdSec + Wazuh under `/api/monitoring/security/webhooks/{source}`
- [ ] HMAC verification with replay window — bad signatures return 401 and log
- [ ] Idempotent on `dedupKey` (re-posting same event does not create duplicate)
- [ ] Pollers for ELK + ntopng with watermarking via `SourceHealth.lastWatermark`
- [ ] Source normalizers all return `NormalizedSecurityEvent` shape

### 6. Correlation engine (Worktree C)
- [ ] Worker consumes new SecurityEvent rows (NOTIFY or queue, not poll)
- [ ] All four default rules seeded (brute-force, recon, malware, suspicious-process)
- [ ] Per-rule rate limit + max-incidents-per-window cap (poison-rule mitigation per Risk R4)
- [ ] Backfilled events bypass live correlation if `@timestamp < now - 5min` (per R6)

### 7. Action layer (Phase 2)
- [ ] `decide(action, target)` looks up `ActionPolicy` first, applies target overrides
- [ ] Panic mode flag is checked at decide-time
- [ ] Executor writes `ActionAudit` with `status='attempting'` BEFORE gateway call (per R9)
- [ ] Existing `/api/monitoring/security/actions/route.ts` is rewritten to delegate, not deleted

### 8. Real-time push (Phase 3)
- [ ] Postgres trigger NOTIFY on SecurityEvent/Incident/ActionAudit inserts
- [ ] Stream route consumes NOTIFY via long-lived client, not interval poll
- [ ] NOTIFY payloads are IDs only, not full rows (per R7)

### 9. Warden seed (Phase 4)
- [ ] Nova exists at `novas/warden.yaml` with system prompt covering: triage incidents, propose/execute actions per tier, post to security room
- [ ] Agent record seeded with tool whitelist limited to security read + write tools + `chat_post`
- [ ] Warden is subscribed to `system.room.security`, NOT Maintenance
- [ ] No autonomous tool execution path that bypasses the action-policy decide step

### 10. Dashboard (Phase 5)
- [ ] Incident-centric layout — raw events are now drawer-only
- [ ] Approval queue exists at its own route
- [ ] Source health panel renders `SourceHealth` rows
- [ ] Existing SOC2 routes/components were not touched

### 11. Retention (Phase 6)
- [ ] TTL 30d on `SecurityEvent`, 365d on `Incident`/`ActionAudit`
- [ ] Hooks into existing `audit-export-daily.ts` pattern; does NOT modify it

### 12. Universal checks (every PR)
- [ ] PR body includes `gitnexus_impact` summary
- [ ] PR body has a Deviations section (even if "none")
- [ ] No `--no-verify` or hook-skipping in commit history
- [ ] No `audit-export.ts` or SOC2 audit-log path modifications
- [ ] New functions have unit tests; new routes have integration tests
- [ ] No new npm dependencies without explicit justification in PR body
- [ ] TypeScript strict, Zod at boundaries, matches `apps/web/src/app/api/admin/audit-retention/cleanup/route.ts` patterns

---

## Severity classification

When you find an issue, classify it:

- **BLOCK** — must be fixed before merge. Examples: tier matrix mismatch, audit-log modification, column drop in migration, missing security-critical test, action executable outside policy gate.
- **MAJOR** — should be fixed before merge but not catastrophic. Examples: missing unit test, undocumented deviation, gitnexus_impact not reported, panic-mode logic gap.
- **MINOR** — nice to fix but not gating. Examples: type narrowness, naming inconsistency, redundant code.
- **OBSERVATION** — not an issue, just a note. Examples: "this approach is fine but here's an alternative for v2."

---

## Output format — what to post and where

For each PR, post a **single review comment** with this exact structure:

```
## SIEM Review — [SIEM <phase-id>]

**Verdict:** APPROVE | APPROVE_WITH_CHANGES | REQUEST_CHANGES | BLOCK

**Checklist scores:**
- Plan alignment: PASS/FAIL
- Tier matrix (if applicable): PASS/FAIL
- Schema integrity (if applicable): PASS/FAIL
- [...other relevant sections...]
- Universal checks: PASS/FAIL

**Findings:**

### BLOCK
- [issue with file:line reference]

### MAJOR
- [issue with file:line reference]

### MINOR
- [issue]

### OBSERVATION
- [note]

**Stack impact:** [Does this PR's issues affect PRs stacked on top? If yes, list which.]
```

Use `gh pr review <number> --comment --body "..."` or `gh pr comment <number> --body "..."`.

After reviewing all PRs, post a **summary issue** titled `SIEM Review — <date>`:

```
gh issue create --title "SIEM Review — 2026-05-20" --body "..."
```

Summary body should include:
- Total PRs reviewed
- Count by verdict (APPROVE / CHANGES / BLOCK)
- Top 3 cross-cutting concerns
- Recommended merge order (or "do not merge any until BLOCK items resolved")
- Link to each PR review

---

## What NOT to do

- Do NOT push code or open follow-up PRs. You're a reviewer.
- Do NOT approve via `gh pr review --approve`. Use comment-only. The human approves.
- Do NOT close PRs. Even if a PR is clearly wrong, leave it open with a BLOCK comment.
- Do NOT post the same finding on multiple PRs unless it actually appears in each.
- Do NOT defer to "looks fine" if you didn't read the diff. Read every diff line.

## Bias toward catching, not approving

If you're uncertain whether something is a problem, post it as an OBSERVATION rather than skipping it. The human can dismiss false positives cheaply; they can't recover from a missed real issue cheaply.

## Specific things you will be tempted to gloss over but MUST check

- **The tier matrix file.** Open `SIEM_PLAN.md` to the matrix table, open the seed file, diff them in your head row-by-row. This is the file most likely to break security.
- **Migration files.** Read the SQL. Look for `DROP COLUMN`, `ALTER TABLE ... DROP`, `RENAME COLUMN`, anything with `CASCADE`.
- **Commit history within the PR.** Look for any commit message that mentions `--no-verify`, "skip hook", "force", or similar.
- **Test files vs. test claims.** PR body says "tests added" — verify each test actually exists and actually tests the claim. Empty test functions count as FAIL.
- **`gh pr view <num> --json files` vs. what the plan said should be touched.** Files outside the expected scope are red flags.

---

## When done

Once all PRs reviewed and summary issue posted: nothing further. Exit.
