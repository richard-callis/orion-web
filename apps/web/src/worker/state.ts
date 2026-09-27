/** Process-wide worker state shared by the task runner, watchers and scheduler. */

// Configurable via SystemSetting — worker.pollIntervalMs and worker.maxConcurrent
// so operators can tune throughput without redeploying. Loaded once at startup.
export const workerConfig = {
  pollIntervalMs: 15_000,
  maxConcurrent:  3,
}

// Maximum length of a knowledge-base note written by the worker (outcomes, watcher state)
export const MAX_NOTE_LENGTH = 8000

export const TASK_TIMEOUT_MS = 60 * 60 * 1000 // 60 minutes
export const WATCHER_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes per watcher run

export const runningTasks = new Set<string>()
// Guards against concurrent watcher runs: the 60s poll interval is shorter
// than many watcher runtimes, so without this a slow watcher would launch
// multiple parallel copies that each issue duplicate mutating tool calls.
export const runningWatchers = new Set<string>()

// Set once shutdown begins: no new tasks are claimed and no periodic job starts.
let stopping = false
export function isStopping(): boolean { return stopping }
export function markStopping(): void { stopping = true }
