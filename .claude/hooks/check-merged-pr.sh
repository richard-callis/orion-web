#!/bin/bash
# PreToolUse hook — blocks git push when the current branch already has a merged PR.
#
# Why: Claude Code was repeatedly pushing new commits to branches whose PRs had
# already been merged into main, causing commits to pile up on stale branches
# and breaking the one-branch-one-PR workflow.
#
# When blocked, the deny reason and additionalContext are surfaced to Claude so
# it automatically creates a new branch from main instead.

set -euo pipefail

HOOK_INPUT=$(cat)
COMMAND=$(echo "$HOOK_INPUT" | jq -r '.tool_input.command // ""')

# Only intercept git push commands
if [[ ! "$COMMAND" =~ ^git[[:space:]]+push ]]; then
  exit 0
fi

# Determine the branch being pushed
BRANCH=$(git -C "$(dirname "$0")/../.." rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

# Nothing to check on detached HEAD or main/master
if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" || "$BRANCH" =~ ^(main|master)$ ]]; then
  exit 0
fi

# gh CLI required — skip gracefully if not available
if ! command -v gh &>/dev/null; then
  exit 0
fi

# Check PR state for this branch
PR_STATE=$(gh pr view "$BRANCH" --json state --jq '.state' 2>/dev/null || echo "NONE")

if [[ "$PR_STATE" == "MERGED" ]]; then
  PR_URL=$(gh pr view "$BRANCH" --json url --jq '.url' 2>/dev/null || echo "")
  jq -n \
    --arg branch "$BRANCH" \
    --arg url "$PR_URL" \
    '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: ("Branch \"" + $branch + "\" already has a merged PR — push blocked."),
        additionalContext: ("The PR for branch \"" + $branch + "\" has been merged (" + $url + "). Do NOT push more commits to this branch. Create a fresh branch from main for the next piece of work:\n  git checkout -b feat/<new-name> origin/main\nThen commit and push the new branch and open a new PR.")
      }
    }'
  exit 0
fi

exit 0
