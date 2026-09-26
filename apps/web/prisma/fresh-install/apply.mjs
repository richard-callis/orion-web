#!/usr/bin/env node
// Fresh-install bootstrap for the ORION database. Run before `prisma migrate deploy`.
//
// The legacy migration chain (legacy-migrations.txt) cannot be replayed on an
// empty database: Prisma applies folders in string order (10_ < 1_ < 20_ < 2_),
// which runs ALTERs before their CREATEs, and several migrations were generated
// against a hand-migrated production database. So:
//
//   * Empty database   -> apply baseline.sql (net effect of the legacy chain) in
//                         one transaction, then record every legacy migration as
//                         applied. `migrate deploy` then applies only the newer,
//                         timestamped migrations.
//   * Baselined DB     -> make sure every legacy migration is recorded (resumes
//                         a bootstrap that was interrupted half-way).
//   * Existing DB      -> no-op; `migrate deploy` behaves exactly as before.
//
// Idempotent and safe to run on every container start.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const schemaPath = join(here, '..', 'schema.prisma')
const require = createRequire(import.meta.url)
const prismaCli = process.env.PRISMA_CLI || require.resolve('prisma/build/index.js')

const legacy = readFileSync(join(here, 'legacy-migrations.txt'), 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l && !l.startsWith('#'))

const url = process.env.DATABASE_URL
if (!url) {
  console.error('fresh-install: DATABASE_URL is not set')
  process.exit(1)
}

const client = new pg.Client({ connectionString: url })
await client.connect()

try {
  const { rows: [state] } = await client.query(`
    SELECT to_regclass('public."User"')               IS NOT NULL AS "hasSchema",
           to_regclass('public._prisma_migrations')    IS NOT NULL AS "hasHistory",
           to_regclass('public."_orion_baseline"')     IS NOT NULL AS "baselined"`)

  let baselined = state.baselined
  if (!state.hasSchema && !state.hasHistory) {
    console.log('fresh-install: empty database, applying baseline.sql')
    const sql = readFileSync(join(here, 'baseline.sql'), 'utf8')
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    }
    baselined = true
  }

  if (!baselined) {
    console.log('fresh-install: existing database, nothing to do')
  } else {
    const applied = new Set()
    const { rows: [{ exists }] } = await client.query(
      `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`)
    if (exists) {
      const { rows } = await client.query(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
      for (const r of rows) applied.add(r.migration_name)
    }
    const missing = legacy.filter(n => !applied.has(n))
    for (const name of missing) {
      execFileSync(process.execPath, [prismaCli, 'migrate', 'resolve', '--applied', name, '--schema', schemaPath],
        { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: '1' } })
    }
    if (missing.length) console.log(`fresh-install: recorded ${missing.length} legacy migrations as applied`)
  }
} finally {
  await client.end()
}
