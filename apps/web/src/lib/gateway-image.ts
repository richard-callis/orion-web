/**
 * Gateway image + probe settings for the manifests ORION hands to remote
 * clusters and Docker hosts.
 *
 * The image tag follows the gateway the management node itself runs
 * (ORION_GATEWAY_IMAGE_TAG, set by compose from ORION_GATEWAY_VERSION /
 * ORION_VERSION), so a re-applied manifest and the image it points at always
 * come from the same release. With no pin the tag falls back to `latest`.
 *
 * Probes stay compatible with gateway images that predate /livez and /readyz:
 *   - liveness always uses /health (present in every gateway image)
 *   - readiness uses /readyz only when the image is pinned to a release that
 *     has it; an unpinned `latest` image may be older, so it gets /health too.
 * GATEWAY_READINESS_PATH overrides the readiness path (e.g. set it to /health
 * before rolling back to a gateway image older than /readyz).
 */

const DEFAULT_ORG = 'richard-callis'

export interface GatewayImageSpec {
  image: string
  pinned: boolean
  pullPolicy: 'Always' | 'IfNotPresent'
  livenessPath: string
  readinessPath: string
}

export function gatewayImageSpec(env: NodeJS.ProcessEnv = process.env): GatewayImageSpec {
  const org = env.GITHUB_ORG?.trim() || DEFAULT_ORG
  const rawTag = env.ORION_GATEWAY_IMAGE_TAG?.trim() || ''
  const tag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(rawTag) ? rawTag : 'latest'
  const pinned = tag !== 'latest'

  const override = env.GATEWAY_READINESS_PATH?.trim()
  const readinessPath = override && /^\/[A-Za-z0-9/_-]*$/.test(override)
    ? override
    : pinned ? '/readyz' : '/health'

  return {
    image: `ghcr.io/${org}/orion-gateway:${tag}`,
    pinned,
    // A pinned tag never changes, so there's nothing to re-pull; `latest`
    // has to be pulled on every restart to pick up new builds.
    pullPolicy: pinned ? 'IfNotPresent' : 'Always',
    livenessPath: '/health',
    readinessPath,
  }
}
