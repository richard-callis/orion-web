# Parking Lot

Ideas and architectural discussions deferred for a future session.

---

## Nova / Nebula — System Agent Distribution

**Date parked:** 2026-05-03

### The question
System agents (Alpha, Validator, Planner, Environment SME, Pulse) are seeded via `seed-system-agents.ts` as Nova DB records with `source: 'bundled'`. They show up in the Nebula catalog. But there's no way to:
1. **Sync a running agent back to its Nova's latest config** — the seed is create-only to preserve admin edits, so there's no "apply latest Nova" button.
2. **Download them on a fresh install without shipping the code** — they're bundled in source, not published to `orion-nub`.

### What was discussed
Two approaches were considered:

**Publish to `orion-nub` (remote catalog)**
Add the system agent JSON configs to the remote `orion-nub` repo. Load them in `loadRemoteNovae()`. The Nebula UI would show a "Sync / Re-import" button that pushes the latest Nova config into the running agent (with an overwrite warning).

**"Sync from Nova" button in Nebula (bundled)**
Keep the configs in `seed-system-agents.ts` but add a UI action in Nebula that re-applies the Nova's current `systemPrompt` / `contextConfig` to the linked agent — useful when you've updated the seed and redeployed but want to push the change to the live agent without a DB migration.

### Why it was parked
The system chatroom architecture needed to be resolved first (agents need somewhere to post before we invest in making their configs more portable). This should be revisited once the System Epic / chatroom seeding is stable.

### Questions to answer before picking it up
- Do we want system agents to be upgradeable independently of an ORION image release?
- Should the "sync" action be admin-only and require explicit confirmation, or can agents trigger it on themselves?
- If configs live in `orion-nub`, who controls the repo and what's the review process for prompt changes?
