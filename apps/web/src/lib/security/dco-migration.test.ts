/** DCO slice 1a migration: additive only, idempotent, with the partial unique index Prisma cannot express. */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sql = readFileSync(join(__dirname, '../../../prisma/migrations/t20261128120000_dco_asset_schema/migration.sql'), 'utf8')
const statements = sql.split('\n').filter(l => !l.trim().startsWith('--'))

describe('t20261128120000_dco_asset_schema', () => {
  it('creates every slice 1a table plus ExpectedContainer', () => {
    for (const t of ['Asset', 'AssetAddress', 'WorkloadAddress', 'AssetStateChange', 'PowerWindow', 'PowerWindowRun', 'ExpectedContainer']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`)
    }
  })

  it('is additive: it only creates objects and adds foreign keys on its own new tables', () => {
    const text = statements.join('\n').replace(/ON DELETE/g, '')
    expect(text).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b|ALTER COLUMN|RENAME/i)
    const alters = [...text.matchAll(/ALTER TABLE "(\w+)"/g)].map(m => m[1])
    expect(alters.length).toBeGreaterThan(0)
    expect(new Set(alters)).toEqual(new Set(['Asset', 'AssetAddress', 'WorkloadAddress', 'AssetStateChange', 'PowerWindow', 'PowerWindowRun', 'ExpectedContainer']))
  })

  it('keeps one live owner per address value via a partial unique index', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "AssetAddress_kind_value_live_key" ON "AssetAddress"\("kind", "value"\) WHERE "validTo" IS NULL/)
  })

  it('is idempotent: no bare CREATE TABLE/INDEX, foreign keys guarded', () => {
    expect(sql).not.toMatch(/CREATE (UNIQUE )?(INDEX|TABLE) (?!IF NOT EXISTS)/)
    expect(sql.match(/ADD CONSTRAINT/g)!.length).toBe(sql.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g)!.length)
  })
})
