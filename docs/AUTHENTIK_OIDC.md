# Authentik OIDC login

Orion offers **Sign in with Authentik** (authorization code + PKCE; NextAuth verifies the
ID token signature, `state` and `nonce`). Local username/password + TOTP stays available as
a break-glass fallback.

## 1. Create the provider in Authentik

1. *Applications → Providers → Create → OAuth2/OpenID Provider*.
2. Client type **Confidential**; note the generated client ID and secret.
3. Redirect URI (strict): `https://<orion-host>/api/auth/callback/authentik`
4. Signing key: any key (RS256). Under *Advanced protocol settings* set **Scopes** to
   `openid`, `email`, `profile` plus a **groups** scope mapping. Authentik has no built-in
   `groups` scope: create *Customization → Property Mappings → Scope Mapping* with scope
   name `groups` and expression `return {"groups": [g.name for g in request.user.ak_groups.all()]}`.
5. Allowed grant types: `authorization_code` and `refresh_token`.
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

Restart the web service. All three empty/missing = provider off and the button is hidden.
The `OIDCProvider.enabled` flag (admin SSO settings) is a runtime kill switch: set it to
`false` to hide/deny Authentik login without a restart.

## 3. Users and roles

- Users are identified by the OIDC `sub` (stored in `User.externalId`, `provider=authentik`).
  A changed Authentik username or email never re-points a linked account.
- On a user's *first* OIDC login they are linked to an existing local user only if the ID
  token has `email_verified: true` and the email matches; otherwise a new user is created.
  If that local user is already bound to another external identity the login is denied.
  Linking keeps the local password, so break-glass login still works.
- Roles are recomputed from the `groups` claim on every login (demotion works), using
  `OIDCProvider.groupMapping` (JSON of group name → `admin` | `user` | `readonly`; the
  highest matching role wins). Default when unset:

  ```json
  { "authentik Admins": "admin" }
  ```

  Everyone else gets `user`. Note: a local admin linked to Authentik who is not in a mapped
  admin group is demoted on their next OIDC login, including for local break-glass login.

## Not covered

Logging out ends the Orion session only; the Authentik session stays active
(RP-initiated logout is a follow-up).
