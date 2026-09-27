/**
 * Structured JSON logger (pino) for the gateway.
 *
 * pino writes straight to stdout (not through console.*), so the console
 * redaction wrapper in ./redact.ts does not see its output. Every string
 * argument is therefore passed through redactSensitive() in a logMethod hook,
 * and common secret-bearing object keys are redacted via pino's `redact`.
 */

import { pino } from 'pino'
import { redactSensitive } from './redact.js'

export const logger = pino({
  name: 'orion-gateway',
  level: process.env.LOG_LEVEL ?? 'info',
  base: { type: process.env.GATEWAY_TYPE ?? 'cluster' },
  redact: {
    paths: [
      'token', 'gatewayToken', 'authorization', 'password', 'secret',
      '*.token', '*.gatewayToken', '*.authorization', '*.password', '*.secret',
      'headers.authorization', 'req.headers.authorization',
    ],
    censor: '***REDACTED***',
  },
  hooks: {
    logMethod(args, method) {
      const redacted = args.map(a => (typeof a === 'string' ? redactSensitive(a) : a))
      return method.apply(this, redacted as Parameters<typeof method>)
    },
  },
})

/** Normalise an unknown thrown value into a loggable message. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
