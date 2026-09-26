# Gateway git credentials

A cluster gateway needs git access for one thing: ArgoCD cloning its
environment's repo. Until this change, every gateway received the org-wide git
provider token from `GET /api/environments/:id/git-provider`, so one
compromised gateway meant write access to every repo in the org, and through
GitOps, every cluster.

Each environment now gets a **read-only credential scoped to its own repo**.

## What each provider gets

| Provider | Credential | ArgoCD clones over | Needs on the org/provider token |
|---|---|---|---|
| Bundled Gitea / Gitea | A bot user `orion-env-<env>-<rand>` with `read` collaborator access on the env repo only, plus a `read:repository` token | HTTPS | Site admin (to create the bot user) |
| GitHub | A read-only SSH deploy key on the env repo | SSH (`git@github.com:owner/repo.git`) | Admin on the env repo (to add deploy keys) |
| GitLab | A project deploy token with `read_repository` | HTTPS | Maintainer on the project |

GitHub has no API for minting repo-scoped HTTPS tokens, so GitHub environments
clone over SSH. ArgoCD ships github.com's SSH host key, but **the in-cluster
Applications for a GitHub environment must use the SSH URL**
(`git@github.com:<owner>/<repo>.git`). The scaffolded `argocd/root-application.yaml`
leaves `repoURL` as the `<GIT_REPO_URL>` placeholder; set it to the URL the
gateway logs (`Registered git repo <url> in ArgoCD`).

The gateway registers the credential as an ArgoCD `repo-creds` template whose
URL prefix is the environment repo (without `.git`), so Applications match with
or without the suffix. The credential itself only grants read access to that
one repo.

Credentials are stored encrypted in `EnvironmentGitCredential` (one per
environment). ORION's own ArgoCD (the one cluster bootstrap registers
Applications in) is not affected.

## Lifecycle

- **Minted** lazily, the first time the gateway asks for it.
- **Replaced** automatically if the environment's repo or the git provider
  changes.
- **Rotated** when a new gateway joins the environment (first join with a
  fresh join token) and when the gateway token is rotated
  (`POST /api/environments/:id/rotate-token`). The old credential is revoked
  at the provider; the gateway re-registers ArgoCD with a new one on its next
  start. An idempotent re-join by the same machine keeps the current credential.
- **Revoked** at the provider when the environment is deleted.

If a provider call fails while revoking, the database row is still removed (so
a fresh credential is minted next time) and the failure is logged with
`[git-cred] failed to revoke ... (remove it manually)`. Look for leftover
`orion-env-*` Gitea users, `orion-argocd-*` GitHub deploy keys, or GitLab
deploy tokens named `orion-argocd-*`.

## Fallback: org-wide token (opt-in)

If the provider token can't mint scoped credentials (for example an external
Gitea token that isn't a site admin, or a GitHub token without admin on the
repo), ORION **refuses** by default. The gateway logs the reason (HTTP 409) and
skips ArgoCD repo registration.

To knowingly accept the old behaviour for such setups, set the SystemSetting
`git.gateway.allowOrgTokenFallback` to `true`. The org token is then handed
out, flagged `orgTokenFallback: true` in the response, and the gateway logs a
warning. It is never stored per environment.

Transient provider errors (5xx, timeouts) never trigger the fallback.

## Upgrading existing deployments

- Existing clusters keep working: their ArgoCD `orion-git-repo` Secret still
  holds the org token until the gateway restarts on the new version. On that
  restart the gateway fetches a scoped credential and overwrites the Secret in
  place. **Update gateways to replace the org token in every cluster.**
- **GitHub environments** switch ArgoCD to SSH. Update each in-cluster
  Application's `repoURL` for the env repo from `https://github.com/<owner>/<repo>`
  to `git@github.com:<owner>/<repo>.git` **before** restarting the gateway on
  the new version, because the restart replaces the org-token Secret that the
  HTTPS URL relied on.
- Gateways older than this change understand only `{ url, token }`. For
  Gitea/GitLab the response keeps those fields, scoped to the one repo. For
  GitHub (SSH) the legacy `token` is empty, so old gateways can't register it.
  Update them.
- If your provider token lacks the permissions in the table above, either grant
  them or set the fallback setting.
