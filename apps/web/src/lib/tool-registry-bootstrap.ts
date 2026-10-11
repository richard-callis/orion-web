/**
 * Registers every tool module that isn't already self-registering into
 * tool-registry.ts, as an import-time side effect.
 *
 * Previously these three register*() calls lived inline in
 * management-tools.ts, so they only ran because the worker's entrypoint
 * (worker.ts) happens to also import other files (watchers.ts,
 * tool-scope.ts) that import management-tools.ts — not because anything in
 * the actual agent tool-call path (room-agents.ts → tool-registry.ts)
 * asked for them. That's an implicit, bundling-order-dependent dependency:
 * split the worker into separate processes/bundles and the siem_, github_
 * and skill tools silently stop existing, with no error — indistinguishable
 * from "the agent has nothing to work with."
 *
 * Import this module for its side effects from wherever tool-registry.ts's
 * dispatch is actually used (room-agents.ts), not just from management-tools.ts.
 */
import { registerWardenManagementTools } from '@/lib/siem/warden-management-tools'
import { registerGithubTools } from '@/lib/github-tools'
import { registerSkillTools } from '@/lib/skill-tools'

registerWardenManagementTools()
registerGithubTools()
registerSkillTools()
