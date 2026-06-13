/**
 * Minimal 5-field cron expression parser — no external dependencies.
 *
 * Field order: minute hour day-of-month month day-of-week
 * Ranges:  [0-59] [0-23] [1-31] [1-12] [0-6]  (0 = Sunday)
 *
 * Supports:
 *   *           — any value
 *   5           — specific value
 *   1-5         — range
 *   1,3,5       — list
 *   *\/5         — step over wildcard
 *   1-5/2       — step over range
 */

interface CronField {
  values: Set<number>
}

const FIELD_RANGES = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 6  }, // day-of-week
]

function parseField(expr: string, min: number, max: number): CronField | null {
  const values = new Set<number>()

  for (const part of expr.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i)
      continue
    }

    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    if (stepMatch) {
      const [, rangeExpr, stepStr] = stepMatch
      const step = parseInt(stepStr, 10)
      if (step < 1) return null

      let start = min
      let end = max

      if (rangeExpr !== '*') {
        const rangeParts = rangeExpr.match(/^(\d+)-(\d+)$/)
        if (!rangeParts) {
          const v = parseInt(rangeExpr, 10)
          if (isNaN(v) || v < min || v > max) return null
          start = v
        } else {
          start = parseInt(rangeParts[1], 10)
          end   = parseInt(rangeParts[2], 10)
          if (start < min || end > max || start > end) return null
        }
      }

      for (let i = start; i <= end; i += step) values.add(i)
      continue
    }

    const rangeMatch = part.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10)
      const hi = parseInt(rangeMatch[2], 10)
      if (lo < min || hi > max || lo > hi) return null
      for (let i = lo; i <= hi; i++) values.add(i)
      continue
    }

    const v = parseInt(part, 10)
    if (isNaN(v) || v < min || v > max) return null
    values.add(v)
  }

  return { values }
}

function parseCronFields(expr: string): CronField[] | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const fields: CronField[] = []
  for (let i = 0; i < 5; i++) {
    const field = parseField(parts[i], FIELD_RANGES[i].min, FIELD_RANGES[i].max)
    if (!field) return null
    fields.push(field)
  }
  return fields
}

/**
 * Validate a 5-field cron expression.
 * Returns true if the expression is valid, false otherwise.
 */
export function parseCron(expr: string): boolean {
  return parseCronFields(expr) !== null
}

/**
 * SOC2: [M-009] Calculate the minimum firing interval (in seconds) for a cron expression.
 * Samples 3 consecutive fire times and returns the smallest gap between them.
 * Returns Infinity if fewer than 2 fire times can be found within 4 years.
 */
export function minCronIntervalSeconds(expr: string, from: Date = new Date()): number {
  const fields = parseCronFields(expr)
  if (!fields) return Infinity

  const times: Date[] = []
  let cursor = from
  for (let i = 0; i < 3; i++) {
    try {
      const t = nextRun(expr, cursor)
      times.push(t)
      cursor = t
    } catch {
      break
    }
  }

  if (times.length < 2) return Infinity

  let minGap = Infinity
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i].getTime() - times[i - 1].getTime()) / 1000
    if (gap < minGap) minGap = gap
  }
  return minGap
}

/**
 * Compute the next run time after `from` (defaults to now) for the given cron expression.
 * Throws if the expression is invalid.
 */
export function nextRun(expr: string, from: Date = new Date()): Date {
  const fields = parseCronFields(expr)
  if (!fields) throw new Error(`Invalid cron expression: "${expr}"`)

  const [minuteField, hourField, domField, monthField, dowField] = fields

  // Start searching from the next minute
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  // Search up to 4 years out to handle rare expressions
  const limit = new Date(from)
  limit.setFullYear(limit.getFullYear() + 4)

  while (cursor < limit) {
    // month check (1-indexed)
    const month = cursor.getMonth() + 1
    if (!monthField.values.has(month)) {
      cursor.setDate(1)
      cursor.setHours(0)
      cursor.setMinutes(0)
      cursor.setMonth(cursor.getMonth() + 1)
      continue
    }

    // day-of-month check
    const dom = cursor.getDate()
    if (!domField.values.has(dom)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0)
      cursor.setMinutes(0)
      continue
    }

    // day-of-week check (0=Sunday)
    const dow = cursor.getDay()
    if (!dowField.values.has(dow)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0)
      cursor.setMinutes(0)
      continue
    }

    // hour check
    const hour = cursor.getHours()
    if (!hourField.values.has(hour)) {
      cursor.setHours(cursor.getHours() + 1)
      cursor.setMinutes(0)
      continue
    }

    // minute check
    const minute = cursor.getMinutes()
    if (!minuteField.values.has(minute)) {
      cursor.setMinutes(cursor.getMinutes() + 1)
      continue
    }

    return new Date(cursor)
  }

  throw new Error(`Could not find next run time for cron expression "${expr}" within 4 years`)
}
