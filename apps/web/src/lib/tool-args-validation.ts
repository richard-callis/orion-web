/**
 * Argument validation for any tool — registry tools against their registered
 * schema, gateway tools against the inputSchema the environment's gateway
 * publishes. Previously only registry tools could be validated, and every
 * gateway tool (kubectl_*, helm_*, custom tools) failed with "Unknown tool".
 */
import { getToolDefinition, validateToolArgs } from './tool-registry'

interface JsonSchemaLike {
  required?: unknown
  properties?: unknown
}

/** Same rules as the registry validator: required fields present, present fields of the declared type. */
export function validateArgsAgainstSchema(schema: unknown, args: unknown): { valid: boolean; errors: string[] } {
  const s = (schema && typeof schema === 'object' ? schema : {}) as JsonSchemaLike
  const obj = (typeof args === 'object' && args !== null && !Array.isArray(args)) ? args as Record<string, unknown> : {}
  const errors: string[] = []

  if (Array.isArray(s.required)) {
    for (const field of s.required) {
      if (typeof field !== 'string') continue
      const v = obj[field]
      if (!(field in obj) || v === undefined || v === null || v === '') errors.push(`field "${field}" is required`)
    }
  }
  if (s.properties && typeof s.properties === 'object') {
    for (const [field, prop] of Object.entries(s.properties as Record<string, unknown>)) {
      if (!(field in obj)) continue
      const type = prop && typeof prop === 'object' ? (prop as { type?: unknown }).type : undefined
      const val = obj[field]
      if (typeof type !== 'string' || val === undefined || val === null) continue
      const actual = Array.isArray(val) ? 'array' : typeof val
      // JSON Schema "integer" values arrive as JS numbers
      const ok = actual === type || (type === 'integer' && actual === 'number' && Number.isInteger(val))
      if (!ok) errors.push(`field "${field}" must be ${type} (got ${actual})`)
    }
  }
  return { valid: errors.length === 0, errors }
}

/**
 * Validate a call's arguments: registry tools against the registry, otherwise
 * against the gateway tool's schema (by name). Names that are neither are
 * rejected as unknown.
 */
export function validateToolCallArgs(
  name: string,
  args: unknown,
  gatewaySchemas: ReadonlyMap<string, unknown>,
): { valid: boolean; errors: string[] } {
  if (getToolDefinition(name)) return validateToolArgs(name, args)
  if (gatewaySchemas.has(name)) return validateArgsAgainstSchema(gatewaySchemas.get(name), args)
  return { valid: false, errors: [`Unknown tool: "${name}"`] }
}
