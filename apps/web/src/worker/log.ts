export function log(msg: string) { process.stdout.write(`[orchestrator] ${msg}\n`) }
export function err(msg: string) { process.stderr.write(`[orchestrator] ERROR: ${msg}\n`) }
