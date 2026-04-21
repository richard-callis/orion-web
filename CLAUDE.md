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
