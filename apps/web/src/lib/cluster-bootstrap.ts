/**
 * Cluster Bootstrap — public entry point.
 *
 * The implementation lives in lib/bootstrap/, split by target:
 *   k8s.ts        K8s/Talos: connectivity, git repo, ArgoCD, gateway,
 *                 monitoring, Vault AppRole + External Secrets Operator
 *   docker.ts     single Docker host (git repo, compose over SSH)
 *   swarm.ts      Docker Swarm (init/join/label, stack deploy)
 *   vault-eso.ts  Vault AppRole, mTLS client cert, ClusterSecretStore
 *   monitoring.ts standalone + in-bootstrap monitoring stacks, ELK credentials
 *   templates/    the generated YAML (gateway, ESO/Vault) as typed pure functions
 */

export { bootstrapCluster, deployMonitoringStack, type BootstrapEvent } from './bootstrap'
export { gatewayManifest, esoVaultManifest, type TLSConfig } from './bootstrap/templates'
