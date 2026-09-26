import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./run.js', () => ({
  run: vi.fn(async () => ({ stdout: 'ok', stderr: '' })),
  runOut: vi.fn(async () => 'ok'),
}))

import { runOut } from './run.js'
import {
  noFlag, k8sName, k8sNamespace, k8sResource, labelSelector, oneOf, duration, durationSeconds,
  dockerName, imageRef, hostOrIp, ArgValidationError,
} from './validate-args'
import { kubernetesTools } from '../builtin-tools/kubernetes'
import { dockerTools } from '../builtin-tools/docker'
import { talosTools } from '../builtin-tools/talos'
import { backupTools } from '../builtin-tools/backup'

const tool = (list: readonly { name: string; execute: (a: Record<string, unknown>) => Promise<string> }[], name: string) => {
  const t = list.find(x => x.name === name)
  if (!t) throw new Error(`no tool ${name}`)
  return t
}

describe('validators', () => {
  it.each(['--server=https://attacker', '-o', '--kubeconfig=/tmp/x', '--as=system:admin'])(
    'noFlag rejects flag-like value %s', v => {
      expect(() => noFlag('name', v)).toThrow(ArgValidationError)
    },
  )

  it('noFlag rejects control characters and empty values', () => {
    expect(() => noFlag('x', 'a\nb')).toThrow(ArgValidationError)
    expect(() => noFlag('x', '')).toThrow(ArgValidationError)
    expect(() => noFlag('x', undefined)).toThrow(ArgValidationError)
  })

  it('k8sName enforces DNS-1123', () => {
    expect(k8sName('n', 'my-app.v1')).toBe('my-app.v1')
    expect(() => k8sName('n', 'My_App')).toThrow()
    expect(() => k8sName('n', 'app/..')).toThrow()
    expect(() => k8sName('n', '-app')).toThrow()
  })

  it('k8sNamespace enforces DNS-1123 label', () => {
    expect(k8sNamespace('ns', 'kube-system')).toBe('kube-system')
    expect(() => k8sNamespace('ns', 'a.b')).toThrow()
  })

  it('k8sResource accepts resource types only', () => {
    expect(k8sResource('r', 'deployments.apps')).toBe('deployments.apps')
    expect(() => k8sResource('r', 'pods --all-namespaces')).toThrow()
    expect(() => k8sResource('r', '--raw=/api')).toThrow()
  })

  it('labelSelector rejects flags and odd characters', () => {
    expect(labelSelector('s', 'app=nginx,tier!=db')).toBe('app=nginx,tier!=db')
    expect(() => labelSelector('s', '-A')).toThrow()
    expect(() => labelSelector('s', 'app=$(id)')).toThrow()
  })

  it('oneOf enforces enums', () => {
    expect(oneOf('o', 'json', ['json', 'yaml'] as const)).toBe('json')
    expect(() => oneOf('o', 'go-template={{.}}', ['json', 'yaml'] as const)).toThrow()
  })

  it('duration parses and bounds values', () => {
    expect(duration('t', '720h0m0s')).toBe('720h0m0s')
    expect(durationSeconds('2m')).toBe(120)
    expect(durationSeconds('1h30m')).toBe(5400)
    expect(() => duration('t', '--timeout=0')).toThrow()
    expect(() => duration('t', '5 minutes')).toThrow()
  })

  it('docker / image / host validators', () => {
    expect(dockerName('c', 'web_1')).toBe('web_1')
    expect(() => dockerName('c', '--privileged')).toThrow()
    expect(imageRef('i', 'ghcr.io/org/app:1.2@sha256:abc')).toContain('ghcr.io')
    expect(() => imageRef('i', '--entrypoint=sh')).toThrow()
    expect(hostOrIp('n', '10.0.0.5')).toBe('10.0.0.5')
    expect(() => hostOrIp('n', '--insecure')).toThrow()
  })
})

describe('built-in tools reject flag injection without running the CLI', () => {
  beforeEach(() => vi.mocked(runOut).mockClear())

  it.each([
    ['kubectl_get', { resource: 'pods', name: '--server=http://attacker:8080' }],
    ['kubectl_get', { resource: 'pods', output: 'go-template={{.}}' }],
    ['kubectl_describe', { resource: 'pod', name: '--kubeconfig=/etc/x' }],
    ['kubectl_delete', { resource: 'pod', name: 'x', namespace: '--as=admin' }],
    ['kubectl_logs', { pod: '--insecure-skip-tls-verify', namespace: 'default' }],
    ['kubectl_rollout_restart', { kind: 'deployment', name: '--server=x', namespace: 'default' }],
    ['kubectl_rollout_restart', { kind: 'pod', name: 'x', namespace: 'default' }],
    ['kubectl_patch', { resource: 'deployment', name: '-o=yaml', patch: '{}' }],
    ['kubectl_exec', { namespace: 'default', pod: '--server=x', command: ['ls'] }],
    ['helm_uninstall', { release: '--kube-apiserver=https://x', namespace: 'default' }],
    ['helm_repo_add', { name: '--insecure-skip-tls-verify', url: 'https://charts.example.com' }],
    ['helm_upgrade_install', { release: 'r', chart: '--post-renderer=/bin/sh', namespace: 'default' }],
  ])('%s %j', async (name, args) => {
    const out = await tool(kubernetesTools, name).execute(args)
    expect(out).toMatch(/^Error: /)
    expect(runOut).not.toHaveBeenCalled()
  })

  it('kubectl_exec no longer allows find/curl/wget/nc/env/printenv', async () => {
    for (const bin of ['find', 'curl', 'wget', 'nc', 'env', 'printenv']) {
      const out = await tool(kubernetesTools, 'kubectl_exec').execute({ namespace: 'default', pod: 'p', command: [bin] })
      expect(out).toContain('not permitted')
    }
    expect(runOut).not.toHaveBeenCalled()
  })

  it('valid kubectl_get puts positionals after --', async () => {
    await tool(kubernetesTools, 'kubectl_get').execute({ resource: 'deployment', name: 'web', namespace: 'prod' })
    expect(runOut).toHaveBeenCalledWith('kubectl', ['get', '-n', 'prod', '-o', 'wide', '--', 'deployment', 'web'], expect.anything())
  })

  it.each([
    ['docker_logs', { container: '--details' }],
    ['docker_inspect', { container: '-f={{.}}' }],
    ['docker_run', { image: '--privileged' }],
    ['docker_run', { image: 'nginx', name: '--net=host' }],
    ['docker_run', { image: 'nginx', ports: ['--cap-add=ALL'] }],
    ['docker_run', { image: 'nginx', env: { 'A=B --privileged': 'x' } }],
  ])('docker %s %j', async (name, args) => {
    const out = await tool(dockerTools, name).execute(args)
    expect(out).toMatch(/^Error: /)
    expect(runOut).not.toHaveBeenCalled()
  })

  it('talos rejects flag-like node and @file patches', async () => {
    const base = { talosConfig: Buffer.from('x').toString('base64') }
    expect(await tool(talosTools, 'talos_get_version').execute({ ...base, nodeIp: '--endpoints=evil' })).toMatch(/^Error: /)
    expect(await tool(talosTools, 'talos_patch_machineconfig').execute({ ...base, nodeIp: '10.0.0.1', patch: '@/etc/shadow' })).toMatch(/^Error: /)
    expect(await tool(talosTools, 'talos_upgrade').execute({ ...base, nodeIp: '10.0.0.1', installerImage: '--insecure' })).toMatch(/^Error: /)
    expect(runOut).not.toHaveBeenCalled()
  })

  it('velero rejects flag-like names', async () => {
    expect(await tool(backupTools, 'velero_create_backup').execute({ name: '--from-schedule=x' })).toMatch(/^Error: /)
    expect(await tool(backupTools, 'velero_restore').execute({ backupName: 'b', targetNamespace: '--all' })).toMatch(/^Error: /)
    expect(runOut).not.toHaveBeenCalled()
  })
})
