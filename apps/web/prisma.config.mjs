// Prisma 7 config. Connection URLs moved out of schema.prisma into here.
// Read DATABASE_URL directly (not `env()` from prisma/config, which throws when
// unset) so `prisma generate` works at image build time without a database.
// Plain .mjs so the runtime image can load it without a TypeScript loader.
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL },
})
