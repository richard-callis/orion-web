# ORION

## Concurrent Worktrees

Multiple Claude instances can work on ORION simultaneously using git worktrees.
All share the same `.git` dir but have isolated working directories.

### Workflow
1. **Create a worktree**: `./orion-worktree.sh create <branch-name>` (default path: `.worktrees/<branch-name>`)
2. **Each instance** works in its own worktree on its own branch
3. **Commit locally** — no need to push until ready
4. **Merge** when done: push the branch, create PR, merge to `main`, then `deploy/bootstrap.sh`

### Available worktrees
```
/opt/orion                                        → main (this directory)
/opt/orion/.worktrees/feat/tools-engine           → feat/tools-engine
/opt/orion/.worktrees/feat/gateway-observability  → feat/gateway-observability
```

### Managing worktrees
```bash
./orion-worktree.sh list     # show all
./orion-worktree.sh delete <branch>   # remove worktree + branch
./orion-worktree.sh open <branch>     # open a new shell on that branch
./orion-worktree.sh create <branch> [path]  # create new (starts from origin/main)
```

## Context Graph Locations

- `context/INDEX.md` — task presets + index of all function-level notes
- `context/gateway-call-graph.md` — gateway boot sequence, all functions, global state
- `context/gateway-tools.md` — all 26 builtin tools, commands, schemas, timeouts
- `context/web-call-graph.md` — auth, agent runners, worker orchestrator, GatewayClient
- `context/api-routes.md` — every API route: DB ops, external calls, response shape
- `context/schema.md` — all Prisma models, fields, and relationships

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **orion-web** (7519 symbols, 11361 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/orion-web/context` | Codebase overview, check index freshness |
| `gitnexus://repo/orion-web/clusters` | All functional areas |
| `gitnexus://repo/orion-web/processes` | All execution flows |
| `gitnexus://repo/orion-web/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
