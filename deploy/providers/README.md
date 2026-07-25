# Provider Novas moved to Orion Nebula

The JSON Nova definitions that lived here (`manifest.json`, `authelia.json`,
`authentik.json`) are now sourced from the suite's catalog repo:

**https://github.com/richard-callis/Orion-nebula**

ORION fetches them at runtime via `NEXT_PUBLIC_PROVIDER_MANIFEST_URL`
(see `deploy/.env.example`), falling back to the bundled configs in
`apps/web/src/lib/provider-engine.ts` if the catalog is unreachable.

Edit the catalog, not this directory.
