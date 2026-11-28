# Authentik OIDC login

Orion offers **Sign in with Authentik** (authorization code + PKCE; NextAuth verifies the
ID token signature, `state` and `nonce`). Local username/password + TOTP stays available as
a break-glass fallback (a local account with TOTP enabled cannot currently complete the
login page's password form, so the break-glass account should not rely on TOTP).

## 1. Automated setup (recommended)

`deploy/authentik-oidc-bootstrap.sh` creates everything in Authentik through its API and stores
the credentials in Vault. It is optional, idempotent (re-running updates in place; existing
objects are matched by slug/name client-side) and runs inside the `orion` container, so the stack
must be up and Vault unsealed. It writes to Vault with the `VAULT_TOKEN` in `deploy/.env`, which
therefore must be set and have write access on `secret/orion/*` (without it `bootstrap.sh` skips the step, and the script run by hand stops with an error before contacting Authentik).

1. In Authentik create an API token for a user that may manage providers, applications, flows,
   groups, policies, property mappings and certificate key pairs (read)
   (*Directory → Tokens and App passwords*, intent *API*). Save it in a
   root-only file (owned by root, mode 600): `install -m 600 /dev/null /root/.orion-authentik-token`,
   then paste the token.
2. Run (from `deploy/`). Use the public Authentik URL: it becomes the OIDC issuer.

   ```bash
   ./authentik-oidc-bootstrap.sh https://authentik.example.com \
     --token-file /root/.orion-authentik-token \
     [--slug orion] [--group "authentik Admins"] [--vault-path secret/orion/authentik-oidc]
   ```

   The token can instead be piped on stdin (`printf %s "$TOKEN" | ./authentik-oidc-bootstrap.sh <url>`).
   It is never taken from argv and never printed. `deploy/bootstrap.sh` runs the same step when
   `AUTHENTIK_BOOTSTRAP_URL` and `AUTHENTIK_BOOTSTRAP_TOKEN_FILE` are set in `deploy/.env`
   (optionally `AUTHENTIK_BOOTSTRAP_SLUG` / `AUTHENTIK_BOOTSTRAP_GROUP`), and skips it otherwise.
   The `bootstrap.sh` route only runs when `bootstrap.sh` itself runs as root (the token file is
   root-only); otherwise it skips the step and you run the script above as root.
   Without `--token-file` on a terminal the token is prompted for (hidden). After a successful run the
   `AUTHENTIK_BOOTSTRAP_*` lines and the token file can be removed (`bootstrap.sh` then skips the
   step); keep them only if you want every deploy to re-converge Authentik.
3. Exit code 0 means Vault was updated and Orion must reload it (`bootstrap.sh` restarts `orion` for
   you; by hand: `docker compose restart orion`). 3 means nothing changed.

It creates, with the default authorization (explicit consent) and invalidation flows and the
default self-signed certificate as signing key:

- an OAuth2 provider `<slug>-oidc`: confidential client, `grant_types` explicitly
  `["authorization_code","refresh_token"]` (the API otherwise leaves it empty and authorize fails
  with "Invalid grant_type for provider"), strict redirect URI
  `https://<ORION_DOMAIN>/api/auth/callback/authentik`, subject mode *hashed user ID*, claims in the
  ID token, and the `openid`, `profile` and a custom email scope mapping;
- the scope mapping `ORION: email (email_verified true)`, which returns the user's email with
  `email_verified: true` (Authentik's default email mapping hard-codes `false`). **This trusts
  Authentik admins**: whoever can edit a user's email in Authentik can make Orion see it as
  verified. It also means new OIDC users are created with the email Authentik reports, and with
  `AUTHENTIK_OIDC_LINK_BY_EMAIL` on it is used for account linking (see section 4);
- an application `ORION` (slug `orion` by default) bound to the provider. On a re-run an existing
  provider keeps any extra property mappings you added (e.g. a `groups` scope) and its name; an
  application whose provider is not OAuth2 is refused (choose another `--slug`);
- a policy binding to the operator-chosen group (default `authentik Admins`), so only members can
  log in. The group must already exist. Bindings from earlier runs with a different group are left in place.

Needs an Authentik version with `redirect_uris` as `{matching_mode, url}` objects and the
`/propertymappings/provider/scope/` endpoint (Authentik 2024.10 or later).

Vault secret (KV v2) at `secret/orion/authentik-oidc`: `issuer`
(`https://<authentik-host>/application/o/<slug>/`), `client_id`, `client_secret`.

## 2. Manual setup (fallback)

Do this when the API route is not an option. Create in Authentik:

1. *Applications → Providers → Create → OAuth2/OpenID Provider*, client type **Confidential**.
2. Redirect URI (strict): `https://<orion-host>/api/auth/callback/authentik`
3. Scopes `openid`, `email`, `profile` (plus `groups` if your `profile` mapping does not emit it:
   scope mapping `return {"groups": [g.name for g in request.user.ak_groups.all()]}`). Keep **Subject
   mode** = *Based on the User's hashed ID* and **Include claims in id_token** = on.
4. Allowed grant types must include `authorization_code` and `refresh_token`.
5. Create an Application using the provider and bind your admin group to it.
6. Enroll MFA in Authentik's authentication flow; Orion does **not** ask OIDC users for its local TOTP.

Then give Orion the values, preferably in Vault (`vault kv put secret/orion/authentik-oidc
issuer=... client_id=... client_secret=-` with the secret on stdin) or in `deploy/.env`:

| Key | Value |
| --- | --- |
| `AUTHENTIK_OIDC_ISSUER` | `https://<authentik-host>/application/o/<slug>/` |
| `AUTHENTIK_OIDC_CLIENT_ID` | client ID |
| `AUTHENTIK_OIDC_CLIENT_SECRET` | client secret (never stored in the DB) |

## 3. How Orion resolves the config

At startup Orion reads `secret/orion/authentik-oidc` from Vault (override the path with
`AUTHENTIK_OIDC_VAULT_PATH`). If it has a complete `issuer`/`client_id`/`client_secret`, those are
used; otherwise the three `AUTHENTIK_OIDC_*` env values are used. Neither complete = provider off
and the button is hidden. The secret is never written to the DB or logged. Vault is read at start;
if it is sealed or unreachable then (e.g. after a host reboot), Orion logs a warning, uses the env
values (or has the provider off if you removed them) only until Vault answers, and retries in the
background every 15s, so the Vault config appears without a restart. Once read it is cached, so
after changing the secret run `docker compose restart orion` (`orion-worker` does not read it).
The token used is the wizard-minted admin token, else `VAULT_TOKEN`.

**Migrating an install that has the values in `.env`:** run the automated step above (it creates or
reuses the Authentik provider and writes Vault; or write the three existing values into Vault by
hand), restart Orion, confirm *Sign in with Authentik* still works, then delete the three
`AUTHENTIK_OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET` lines from `deploy/.env` and run
`docker compose up -d orion` so the container drops the old env values. Vault wins when both
exist, so do not leave stale values in Vault. If the automated step created a new provider, the old
one in Authentik can be deleted.

Before enabling, check `/admin/sso`: an existing `OIDCProvider` row's `groupMapping`
overrides the default mapping below.

The `OIDCProvider.enabled` flag (set via `PATCH /api/admin/sso`; there is no toggle on the
SSO page) is a runtime kill switch: `false` blocks new Authentik logins without a restart;
existing sessions last until expiry (up to 8h). It is the same flag that gates the dormant
`x-authentik-*` header mode, so disabling OIDC also disables header mode, and re-enabling
it re-arms header mode (turn `headerMode` off separately if you do not want that).

## 4. Users and roles

- Users are identified by the OIDC `sub` (stored in `User.externalId`, `provider=authentik`).
  A changed Authentik username or email never re-points a linked account.
- By default a first OIDC login always creates a new user (if its verified email already belongs to another
  account, the new user gets a placeholder email instead). Setting
  `AUTHENTIK_OIDC_LINK_BY_EMAIL=true` instead links to an existing local user when the ID
  token has `email_verified: true` and the email matches. **Caveat:** Authentik's default
  `email` scope mapping hard-codes `email_verified` (false in current releases, so linking would
  never match), and the automated setup replaces it with a mapping that always reports true. Its
  default user-settings flow also lets users edit their own email, so with linking on any Authentik
  user could claim a local account's address and take it over. Enable linking only after removing
  the email field from the user-settings flow, and only if you trust every Authentik admin to set emails.
  If the matching local user is already bound to another external identity, or the email
  matches more than one account, the login is denied.
  Linking keeps the local password, so break-glass login still works (the admin Users page
  still offers *Set password* for such accounts). Deleting the user instead discards the
  password: they are re-created without it on their next login.
- The setup wizard's admin has email `<username>@local`, so it is never auto-linked; the
  operator's first OIDC login creates a second account.
- Roles are recomputed from the `groups` claim on every login (demotion works), using
  `OIDCProvider.groupMapping` (JSON of group name → `admin` | `user` | `readonly`; the
  highest matching role wins). Default when unset:

  ```json
  { "authentik Admins": "admin" }
  ```

  Everyone else gets `user`. Note: a local admin linked to Authentik who is not in a mapped
  admin group is demoted on their next OIDC login, including for local break-glass login.
  If the ID token has no `groups` claim at all, existing users keep their role.

## Not covered

Logging out ends the Orion session only; the Authentik session stays active
(RP-initiated logout is a follow-up).
