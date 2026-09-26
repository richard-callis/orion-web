# Database migrations

## How migrations run

On every container start `entrypoint.sh` runs:

1. `node prisma/fresh-install/apply.mjs`. On an **empty** database this applies
   `fresh-install/baseline.sql` and records every migration in
   `fresh-install/legacy-migrations.txt` as applied. On an existing database it
   does nothing.
2. `prisma migrate deploy` applies any migration not yet recorded.

## Why there is a baseline

The first 61 migrations (`legacy-migrations.txt`) can't be replayed on an empty
database, for two reasons:

- **Sort order.** Prisma applies migration folders in string order, so
  `10_* < 1_* < 20260615_* < 20_* < 2_*`. That runs ALTERs before the CREATEs
  they depend on.
- **Hand-migrated history.** Some legacy migrations were generated against a
  production database that had been migrated by hand. For example,
  `5_ring_leader_hooks_evals` renames constraints that `2_add_managed_secrets`
  never creates.

Existing databases already have all of them applied, so they are unaffected.

## Adding a migration

Name new migrations `tYYYYMMDDHHMMSS_short_description` (UTC), for example
`t20260926130000_fk_indexes_and_ondelete`.

Prisma sorts folder names byte-wise, and `'2' < '_'`. So a bare
`2026…_` name sorts before the legacy `20_`…`29_` folders and could run before
the migration that created its table. The leading letter makes every new
migration sort after all digit-prefixed legacy folders, and the timestamps keep
new migrations in order among themselves. Always use a timestamp later than the
newest existing `t…` folder.

**Do not use `prisma migrate dev` or `prisma db push`.** Its shadow-database
replay fails on the legacy chain. Also, `schema.prisma` declares a few columns
Prisma can't represent (pgvector `embedding`, the generated
`Note.searchVector`), so `migrate dev` would try to "fix" them and drop the
HNSW and GIN indexes.

Instead:

1. **Edit `schema.prisma`.**
2. **Generate the SQL** against the previous version of the schema:
   ```bash
   git show HEAD:apps/web/prisma/schema.prisma > /tmp/schema.before.prisma
   npx prisma migrate diff \
     --from-schema-datamodel /tmp/schema.before.prisma \
     --to-schema-datamodel prisma/schema.prisma --script \
     > prisma/migrations/t$(date -u +%Y%m%d%H%M%S)_my_change/migration.sql
   ```
3. **Make the SQL idempotent.** Use `IF NOT EXISTS` / `IF EXISTS`. Never rely
   on constraint names from older migrations; see how
   `t20260926130000_fk_indexes_and_ondelete` locates FKs by column.
4. **Verify** against a throwaway database with `prisma/check-drift.sh`. CI runs
   the same check on every PR.

## Rules

- **Never edit a migration that has been applied anywhere.** Write a new one.
- **Never edit `baseline.sql` or `legacy-migrations.txt`.** They are frozen.
- **Destructive changes need two steps.** Before dropping a column or table,
  ship the code that stops using it first, then the migration in a later
  release. Deploys run `deploy/backup.sh --pre-deploy` before migrating; that
  dump is the only way to undo a migration.
