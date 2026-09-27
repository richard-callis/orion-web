import { gatewayImageSpec } from '../../gateway-image'
import { ORION_URL } from '../config'
import { renderGatewayManifest } from './gateway-manifest'

export { renderGatewayManifest, type GatewayManifestInput } from './gateway-manifest'
export { esoVaultManifest, type TLSConfig } from './eso-vault-manifest'

/** Gateway manifest for this ORION instance (its callback URL + gateway image). */
export function gatewayManifest(envName: string, joinToken: string): string {
  return renderGatewayManifest({ envName, joinToken, orionUrl: ORION_URL, image: gatewayImageSpec() })
}
