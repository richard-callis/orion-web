import { describe, it, expect } from 'vitest'
import { toEnvironmentDTO, isUnchangedSecret, mergeEnvironmentMetadata, SECRET_MASK } from './environment-dto'

describe('toEnvironmentDTO', () => {
  const env = {
    id: 'e1',
    name: 'prod',
    gatewayToken: 'gw-secret',
    kubeconfig: 'a3ViZWNvbmZpZw==',
    federationToken: 'enc:v1:abc',
    metadata: { nodeIp: '10.0.0.1', talosConfig: 'dGFsb3M=' },
    agents: [{ agentId: 'a1', agent: { id: 'a1', name: 'bot', mcpToken: 'mcp-secret' } }],
  }

  it('strips every credential and reports which are set', () => {
    const dto = toEnvironmentDTO(env)
    expect(dto.gatewayToken).toBeNull()
    expect(dto.kubeconfig).toBeNull()
    expect(dto.federationToken).toBeNull()
    expect(dto.metadata).toEqual({ nodeIp: '10.0.0.1' })
    expect(dto.agents?.[0].agent?.mcpToken).toBeNull()
    expect(dto).toMatchObject({ hasGatewayToken: true, hasKubeconfig: true, hasFederationToken: true, hasTalosConfig: true })
    expect(JSON.stringify(dto)).not.toMatch(/gw-secret|a3ViZWNvbmZpZw|enc:v1|dGFsb3M|mcp-secret/)
  })

  it('reports unset credentials as false', () => {
    const dto = toEnvironmentDTO({ id: 'e2', gatewayToken: null, kubeconfig: null, federationToken: null, metadata: null })
    expect(dto).toMatchObject({ hasGatewayToken: false, hasKubeconfig: false, hasFederationToken: false, hasTalosConfig: false, metadata: null })
  })

  it('does not mutate the input', () => {
    toEnvironmentDTO(env)
    expect(env.metadata.talosConfig).toBe('dGFsb3M=')
    expect(env.agents[0].agent.mcpToken).toBe('mcp-secret')
  })
})

describe('isUnchangedSecret', () => {
  it('treats omitted and the legacy mask as "keep"', () => {
    expect(isUnchangedSecret(undefined)).toBe(true)
    expect(isUnchangedSecret(SECRET_MASK)).toBe(true)
    expect(isUnchangedSecret(null)).toBe(false)
    expect(isUnchangedSecret('')).toBe(false)
    expect(isUnchangedSecret('new')).toBe(false)
  })
})

describe('mergeEnvironmentMetadata', () => {
  it('keeps the stored talosConfig when the client omits it', () => {
    expect(mergeEnvironmentMetadata({ nodeIp: 'a', talosConfig: 'T' }, { nodeIp: 'b' }))
      .toEqual({ nodeIp: 'b', talosConfig: 'T' })
  })

  it('keeps the stored talosConfig for empty or masked values', () => {
    expect(mergeEnvironmentMetadata({ talosConfig: 'T' }, { talosConfig: '' })).toEqual({ talosConfig: 'T' })
    expect(mergeEnvironmentMetadata({ talosConfig: 'T' }, { talosConfig: SECRET_MASK })).toEqual({ talosConfig: 'T' })
  })

  it('replaces talosConfig when a new one is sent', () => {
    expect(mergeEnvironmentMetadata({ talosConfig: 'T' }, { talosConfig: 'N' })).toEqual({ talosConfig: 'N' })
  })

  it('handles missing stored metadata', () => {
    expect(mergeEnvironmentMetadata(null, { nodeIp: 'x', talosConfig: '' })).toEqual({ nodeIp: 'x' })
  })
})
