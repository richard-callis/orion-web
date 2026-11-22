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
| Bundled Gitea, `git.gateway.bundledGiteaSsh` on (new installs) | A read-only SSH deploy key on the env repo, plus Gitea's SSH host keys | SSH (`ssh://git@<MANAGEMENT_IP>:2222/owner/repo.git`) | Admin on the env repo (to add deploy keys) |
| Bundled Gitea, setting off (installs from before H2) | As external Gitea | plain HTTP (`http://<MANAGEMENT_IP>:3002/owner/repo.git`) | Site admin |
| External Gitea | A bot user `orion-env-<env>-<rand>` with `read` collaborator access on the env repo only, plus a `read:repository` token | HTTPS | Site admin (to create the bot user) |
| GitHub | A read-only SSH deploy key on the env repo | SSH (`git@github.com:owner/repo.git`) | Admin on the env repo (to add deploy keys) |
| GitLab | A project deploy token with `read_repository` | HTTPS | Maintainer on the project |

GitHub has no API for minting repo-scoped HTTPS tokens, so GitHub environments
clone over SSH. ArgoCD ships github.com's SSH host key, but **the in-cluster
Applications for a GitHub environment must use the SSH URL**
(`git@github.com:<owner>/<repo>.git`). The scaffolded `argocd/root-application.yaml`
leaves `repoURL` as the `<GIT_REPO_URL>` placeholder; set it to the URL the
gateway logs (`Registered git repo <url> in ArgoCD`).

The bundled Gitea serves plain HTTP on the LAN, so with the SystemSetting
`git.gateway.bundledGiteaSsh` on, its environments clone over SSH instead
(hardening step H2). The setup wizard turns it on when it configures the bundled
Gitea; installs from before H2 keep HTTP until it is turned on (see Upgrading).
ArgoCD never accepts an unknown SSH host key and
doesn't ship Gitea's, so ORION reads them on its compose network (`ssh-keyscan`
to the `gitea` service, port 22) and sends them with the credential as
known_hosts lines for `[MANAGEMENT_IP]:2222` (`GITEA_SSH_PORT` if the published
port differs). The gateway merges them into `argocd-ssh-known-hosts-cm` before
registering the credential, replacing an older key for the same host and type
and leaving every other entry alone. It only takes keys for the host in the
credential's own URL, so ORION can never re-key another host (github.com, say).
ORION reads the host keys before it issues or replaces any credential, and if
it can't, it returns 502 and leaves the current credential alone.

As with GitHub, the in-cluster Applications (and their AppProject's
`sourceRepos`) must use the SSH URL the gateway logs.

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
  at the provider. A writable gateway re-registers ArgoCD with a new one on its
  next start; where ORION wrote the Secret it does it at once, with the stored admin
  kubeconfig (see Bootstrapped clusters). An idempotent re-join by the same machine keeps the current credential.
- **Revoked** at the provider when the environment is deleted.

**Bootstrapped clusters.** The gateway that cluster bootstrap deploys is read-only
and never fetches the credential, so ORION writes it with the environment's admin
kubeconfig. Bootstrap installs ArgoCD if the cluster has none, pins the host keys,
and writes the `orion-git-repo` Secret in ArgoCD's namespace. When a gateway joins or
its token is rotated, the credential is revoked and ORION replaces the Secret right
after. Only a Secret ORION wrote (label `orion/registered-by`): one a writable gateway
wrote, or ArgoCD's own key, is left alone. If that gateway has since become read-only,
its Secret holds a revoked credential after the next join or rotation: run bootstrap, or
give ArgoCD its own key.

**Re-run bootstrap** after changing the git provider, the repo or
`git.gateway.bundledGiteaSsh`, and when ORION logs `[argocd-repo] could not
re-register` (the cluster was unreachable, or ORION restarted in the middle). Until
then ArgoCD can't sync.

**Gateways deployed by an older release** stay bound to cluster-admin: re-running
bootstrap only warns. Delete Deployment `orion-management/orion-gateway` and re-run
it. The gateway then joins afresh, read-only, and its old token stops working. If
another ClusterRoleBinding gives its ServiceAccount cluster-admin, or that can't be
checked, bootstrap stops.

Bootstrap needs a gateway image of its own ORION release or newer: an older one can't
join without a URL, or ignores `GATEWAY_READ_ONLY` (it still has only read-only RBAC).

A read-only gateway refuses writes, so ingress bootstrap then uses the stored admin
kubeconfig. Storage bootstrap and DNS bootstrap, sync and records
go through the gateway only, and don't work with a read-only one.

If a provider call fails while revoking, the database row is still removed (so
a fresh credential is minted next time) and the failure is logged with
`[git-cred] failed to revoke ... (remove it manually)`. Look for leftover
`orion-env-*` Gitea users, `orion-argocd-*` Gitea or GitHub deploy keys, or GitLab
deploy tokens named `orion-argocd-*`.

## Fallback: org-wide token (opt-in)

If the provider token can't mint scoped credentials (for example an external
Gitea token that isn't a site admin, or a GitHub token without admin on the
repo), ORION **refuses** by default. The gateway (HTTP 409) or, for a bootstrapped
cluster, bootstrap logs the reason and skips ArgoCD repo registration.

To knowingly accept the old behaviour for such setups, set the SystemSetting
`git.gateway.allowOrgTokenFallback` to `true`. The org token is then handed
out, flagged `orgTokenFallback: true` in the response, and the gateway logs a
warning. It is never stored per environment.

Transient provider errors (5xx, timeouts) never trigger the fallback, and
neither does a provider whose clone URL is SSH (GitHub, bundled Gitea): the org
token is an HTTPS password, which ArgoCD would never match to the SSH URL.

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
- **Bundled Gitea, moving to SSH (H2)** on an install from before it. The
  setting is global: once it is on, *every* environment's gateway switches on
  its next restart, planned or not (a pod reschedule counts). So:
  1. For any cluster whose gateway can't write to the `argocd` namespace (a
     read-only gateway), first give that cluster's ArgoCD its own deploy key and
     Gitea's host key in Git. Its gateway can write neither the Secret nor the
     ConfigMap. With `GATEWAY_READ_ONLY` it doesn't fetch the credential either;
     without it, a restart only revokes the old bot user, which is harmless with
     ArgoCD on its own key. A bootstrapped cluster instead follows steps 2 and 3,
     then re-runs bootstrap in place of step 4.
  2. In **every** environment repo, change the in-cluster Applications'
     `repoURL` and the AppProject's `sourceRepos` to
     `ssh://git@<MANAGEMENT_IP>:2222/<owner>/<repo>.git`, keeping the HTTP URL in
     `sourceRepos` for now.
  3. Set the SystemSetting `git.gateway.bundledGiteaSsh` to `true`.
  4. Restart each writable gateway. Its credential fetch revokes the HTTP bot
     user, issues a deploy key, pins Gitea's host key in
     `argocd-ssh-known-hosts-cm` and replaces the `orion-git-repo` Secret.
  5. Drop the HTTP URL from `sourceRepos`.

  Do steps 2 to 4 back to back: once step 2 syncs, the Applications point at the
  SSH URL, which has no credential or host key until step 4, so they can't sync
  in between.
- Gateways older than this change understand only `{ url, token }`. For
  Gitea/GitLab the response keeps those fields, scoped to the one repo. For
  GitHub (SSH) the legacy `token` is empty, so old gateways can't register it.
  Update them.
- If your provider token lacks the permissions in the table above, either grant
  them or set the fallback setting.
