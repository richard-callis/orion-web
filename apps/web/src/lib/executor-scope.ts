/**
 * H2: the executor authenticates to ORION with ORION_EXECUTOR_TOKEN only (it no
 * longer holds ORION_GATEWAY_TOKEN). This is the complete list of API calls that
 * token may make — middleware.ts lets x-executor-token through for these and
 * nothing else, and each route re-checks its own narrower rule.
 *
 * Edge-safe: no Node or Prisma imports (used by middleware).
 */

/** The only SystemSetting key the executor reads (where to post approval notices). */
export const EXECUTOR_READABLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'system.room.execution',
])

const EXECUTION_RE = /^\/api\/executions\/[^/]+$/
const ROOM_MESSAGES_RE = /^\/api\/chatrooms\/[^/]+\/messages$/
const SETTING_RE = /^\/api\/system-settings\/([^/]+)$/

export function isExecutorAllowedRequest(method: string, pathname: string): boolean {
  const m = method.toUpperCase()

  // Execution records: list/create, and read/update one row. Not /review — that's
  // the human approval endpoint.
  if (pathname === '/api/executions') return m === 'GET' || m === 'POST'
  if (EXECUTION_RE.test(pathname)) return m === 'GET' || m === 'PATCH'

  // Posting an approval notice into a chat room (the route further restricts
  // this to the configured execution room).
  if (m === 'POST' && ROOM_MESSAGES_RE.test(pathname)) return true

  // Reading the execution-room setting.
  const setting = SETTING_RE.exec(pathname)
  if (m === 'GET' && setting) {
    let key: string
    try {
      key = decodeURIComponent(setting[1])
    } catch {
      return false
    }
    return EXECUTOR_READABLE_SETTING_KEYS.has(key)
  }

  return false
}
