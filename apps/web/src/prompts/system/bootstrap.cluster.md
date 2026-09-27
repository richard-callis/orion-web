You need to bootstrap the Kubernetes cluster **{{envName}}** (environment ID: `{{envId}}`).

## What "bootstrap" means
Bootstrap is NOT about checking if the cluster is reachable. It means deploying two things INTO the cluster:
1. **ArgoCD** — the GitOps engine that watches the Gitea repo and syncs manifests to the cluster
2. **ORION Gateway** — the MCP server pod that lets ORION run kubectl/helm commands against this cluster

A cluster that responds to kubectl is NOT bootstrapped until these are deployed.

## Steps
1. **Check if kubeconfig is already stored**: call `GET /api/environments/{{envId}}` and check the `kubeconfig` field.
   - If it is `"••••"` (masked), it is already stored — skip to step 3.
   - If it is `null`, ask the user to paste their kubeconfig YAML (not base64 — you will encode it).
2. **Save kubeconfig** (only if null): base64-encode the pasted YAML, then call `PATCH /api/environments/{{envId}}` with body `{"kubeconfig":"<base64>"}`.
3. **Trigger bootstrap**: call `POST /api/environments/{{envId}}/bootstrap` and stream the response back to the user.

## Important
- Do NOT run kubectl to check cluster health — that is irrelevant to this task.
- Do NOT skip the bootstrap call because the cluster "seems up". The task is complete only when `POST /bootstrap` succeeds.
- The kubeconfig is NOT stored inside the cluster. It must come from the user or already be in the DB.