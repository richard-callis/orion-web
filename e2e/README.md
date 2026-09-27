# End-to-end tests

These run against a live ORION instance. The default is `http://localhost:3000`;
for an isolated stack use `deploy/docker-compose.test.yml`.

| Variable | Purpose |
|---|---|
| `ORION_E2E_BASE_URL` | Target URL (default `http://localhost:3000`) |
| `ORION_E2E_USER` / `ORION_E2E_PASSWORD` | Test account for authenticated checks. Never commit these. |

```bash
npx playwright install chromium            # once
npm run test:e2e                           # specs/ via playwright.config.mjs
node e2e/scripts/test-csp-nonce.mjs        # legacy one-off diagnostic scripts
e2e/smoke.sh all                           # SOC2 smoke suite (brings up deploy/ compose)
```

The scripts in `scripts/` are the older ad-hoc checks. They were moved here
from the repo root and now read their settings from the environment. New
coverage goes in `specs/`.
