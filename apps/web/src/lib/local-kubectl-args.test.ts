import { describe, expect, it } from 'vitest'
import { localKubectlArgs } from './local-kubectl-args'

describe('localKubectlArgs', () => {
  it('kubectl_get: positional resource and name, never --resource/--name flags', () => {
    expect(localKubectlArgs('kubectl_get', { resource: 'service', name: 'traefik', namespace: 'kube-system', output: 'json' }))
      .toEqual(['get', 'service', 'traefik', '-n', 'kube-system', '-o', 'json'])
    expect(localKubectlArgs('kubectl_get', { resource: 'namespace', name: 'metallb-system' }))
      .toEqual(['get', 'namespace', 'metallb-system', '-o', 'wide'])
  })
  it('kubectl_patch: JSON patch as one argument, namespace optional', () => {
    const patch = JSON.stringify([{ op: 'remove', path: '/spec/ports/0/nodePort' }])
    expect(localKubectlArgs('kubectl_patch', { resource: 'service', name: 'traefik', namespace: 'kube-system', patchType: 'json', patch }))
      .toEqual(['patch', 'service', 'traefik', '-n', 'kube-system', '--type=json', `--patch=${patch}`])
    expect(localKubectlArgs('kubectl_patch', { resource: 'storageclass', name: 'x', patch: '{}' }))
      .toEqual(['patch', 'storageclass', 'x', '--type=merge', '--patch={}'])
  })
  it('kubectl_rollout_status', () => {
    expect(localKubectlArgs('kubectl_rollout_status', { kind: 'deployment', name: 'controller', namespace: 'metallb-system', timeout: '180s' }))
      .toEqual(['rollout', 'status', 'deployment/controller', '-n', 'metallb-system', '--timeout=180s'])
  })
  it('anything else is not handled here', () => {
    expect(localKubectlArgs('kubectl_apply_manifest', { manifest: 'x' })).toBeNull()
  })
})
