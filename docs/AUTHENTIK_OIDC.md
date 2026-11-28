# Authentik OIDC login

Orion offers **Sign in with Authentik** (authorization code + PKCE; NextAuth verifies the
ID token signature, `state` and `nonce`). Local username/password + TOTP stays available as
a break-glass fallback (a local account with TOTP enabled cannot currently complete the
login page's password form, so the break-glass account should not rely on TOTP).

## 1. Create the provider in Authentik

1. *Applications → Providers → Create → OAuth2/OpenID Provider*.
2. Client type **Confidential**; note the generated client ID and secret.
3. Redirect URI (strict): `https://<orion-host>/api/auth/callback/authentik`
4. Signing key: any key (RS256). Under *Advanced protocol settings* set **Scopes** to
   `openid`, `email`, `profile` plus a **groups** scope mapping. Depending on the Authentik
   version the default `profile` mapping may already emit `groups`; if not, create
   *Customization → Property Mappings → Scope Mapping* with scope name `groups` and
   expression `return {"groups": [g.name for g in request.user.ak_groups.all()]}`.
   Keep **Subject mode** = *Based on the User's hashed ID* (email- or username-based modes
   change `sub` when that attribute changes and would create a duplicate account) and keep
   **Include claims in id_token** = on (Orion only reads ID-token claims; without `groups`
   there, roles are left unchanged for existing users and new users get `user`).
5. The provider must use the `authorization_code` flow with refresh tokens enabled
   (check the field names against your Authentik version's UI).
6. Create an Application using this provider (the slug appears in the issuer URL).
7. Enroll MFA in Authentik's authentication flow — Orion does **not** ask OIDC users for
   its local TOTP.

## 2. Configure Orion

In `deploy/.env` (a fresh install's `.env.example` already has the keys, empty):

| Key | Value |
| --- | --- |
| `AUTHENTIK_OIDC_ISSUER` | `https://<authentik-host>/application/o/<slug>/` |
| `AUTHENTIK_OIDC_CLIENT_ID` | client ID from step 1 |
| `AUTHENTIK_OIDC_CLIENT_SECRET` | client secret from step 1 (secret; never stored in the DB) |

Run `docker compose up -d orion orion-worker` (a plain restart does not reload `.env`).
All three empty/missing = provider off and the button is hidden.
`AUTHENTIK_OIDC_LINK_BY_EMAIL` is optional and off by default (see section 3).

Before setting the keys, check `/admin/sso`: an existing `OIDCProvider` row's `groupMapping`
overrides the default mapping below.

The `OIDCProvider.enabled` flag (set via `PATCH /api/admin/sso`; there is no toggle on the
SSO page) is a runtime kill switch: `false` blocks new Authentik logins without a restart;
existing sessions last until expiry (up to 8h). It is the same flag that gates the dormant
`x-authentik-*` header mode, so disabling OIDC also disables header mode, and re-enabling
it re-arms header mode (turn `headerMode` off separately if you do not want that).

## 3. Users and roles

- Users are identified by the OIDC `sub` (stored in `User.externalId`, `provider=authentik`).
  A changed Authentik username or email never re-points a linked account.
- By default a first OIDC login always creates a new user. Setting
  `AUTHENTIK_OIDC_LINK_BY_EMAIL=true` instead links to an existing local user when the ID
  token has `email_verified: true` and the email matches. **Caveat:** Authentik's default
  `email` scope mapping reports `email_verified` as always true and its default user-settings
  flow lets users edit their own email, so any Authentik user could claim a local account's
  address and take it over. Enable this only with a custom `email` scope mapping that returns
  a real verification state and with the email field removed from the user-settings flow.
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
