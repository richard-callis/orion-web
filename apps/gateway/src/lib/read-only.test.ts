import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { kubernetesTools } from '../builtin-tools/kubernetes.js'
import { dockerTools } from '../builtin-tools/docker.js'
import { localhostTools } from '../builtin-tools/localhost.js'
import { talosTools } from '../builtin-tools/talos.js'
import { knowledgeGraphTools } from '../builtin-tools/knowledge-graph.js'
import { securityTools } from '../builtin-tools/security.js'
import { trivyTools } from '../builtin-tools/trivy.js'
import { discoveryTools } from '../builtin-tools/discovery.js'
import { backupTools } from '../builtin-tools/backup.js'
import { READ_ONLY_TOOLS, isReadOnly, readOnlyBuiltins, readOnlyPolicy, refuseSecrets } from './read-only.js'

const all = ([kubernetesTools, dockerTools, localhostTools, talosTools, knowledgeGraphTools, securityTools, trivyTools, discoveryTools, backupTools] as unknown as Array<Array<{ name: string }>>).flat()

describe('READ_ONLY_TOOLS', () => {
  it('names only tools that exist', () => {
    const names = new Set(all.map(t => t.name))
    expect([...READ_ONLY_TOOLS].filter(n => !names.has(n))).toEqual([])
  })

  it('leaves out exactly these (a new tool must be classified here)', () => {
    expect([...new Set(all.map(t => t.name))].filter(n => !READ_ONLY_TOOLS.has(n)).sort()).toEqual([
      'crowdsec_decision_create', 'crowdsec_decision_delete', 'docker_exec', 'docker_inspect', 'docker_run', 'file_read', 'firewall_block',
      'helm_list', 'helm_repo_add', 'helm_uninstall', 'helm_upgrade_install', 'knowledge_embed_all',
      'kubectl_apply_manifest', 'kubectl_apply_url', 'kubectl_delete', 'kubectl_exec', 'kubectl_patch', 'kubectl_rollout_restart',
      'security_propose_action', 'shell_exec', 'system_info', 'talos_patch_machineconfig', 'talos_reboot', 'talos_upgrade',
      'trivy_scan_host', 'trivy_scan_image', 'trivy_scan_k8s', 'velero_create_backup', 'velero_restore', 'wazuh_active_response',
    ])
  })
})

describe('isReadOnly', () => {
  it('is off only when unset or explicitly off', () => {
    for (const v of [undefined, '', ' ', 'false', 'FALSE', '0', 'no', 'off']) expect(isReadOnly(v), String(v)).toBe(false)
    for (const v of ['true', '1', 'yes', 'ture', 'enabled']) expect(isReadOnly(v), v).toBe(true)
  })
})

describe('filters', () => {
  const tool = (name: string, builtIn: boolean, execType = 'builtin') => ({ name, builtIn, execType } as never)
  it('registers allowlisted built-ins only', () => {
    expect(readOnlyBuiltins([{ name: 'kubectl_get' }, { name: 'kubectl_delete' }, { name: 'brand_new' }]).map(t => t.name)).toEqual(['kubectl_get'])
  })
  it('offers no custom tool, even under an allowlisted name, and nothing unregistered', () => {
    const policy = [
      tool('kubectl_get', true), tool('kubectl_delete', true),
      tool('kubectl_logs', false, 'shell'), tool('my_http', false, 'http'),
      tool('docker_ps', true, 'shell'), // claims to be built in, not registered here
      tool('toString', true),
    ]
    expect(readOnlyPolicy(policy, { kubectl_get: {}, kubectl_logs: {} }).map(t => (t as { name: string }).name)).toEqual(['kubectl_get'])
  })
})

describe('ELK index argument', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
  const run = async (index: string) => {
    const fetch = vi.fn(async () => new Response('{"hits":{"hits":[]}}'))
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('ELASTICSEARCH_URL', 'http://es:9200')
    const out: string[] = []
    for (const name of ['elk_flow_search', 'elk_syslog_search']) {
      const t = (securityTools as unknown as Array<{ name: string; execute: (a: object) => Promise<string> }>).find(x => x.name === name)!
      out.push(await t.execute({ index, query: '{}' }))
    }
    return { out, fetch }
  }
  it('refuses anything that could leave the search endpoint', async () => {
    for (const bad of ['x/_delete_by_query?', '../_cluster', 'a b', 'a?b', 'a#b', 'a%2f_bulk', '_all/_close', '', 'a,,b']) {
      const { out, fetch } = await run(bad)
      expect(out.every(o => o.startsWith("Error: Invalid argument 'index'")), bad).toBe(true)
      expect(fetch).not.toHaveBeenCalled()
    }
  })
  it('accepts names and patterns', async () => {
    for (const ok of ['flow-*', 'syslog-2026.11.22', '*', 'a,b-*,-c']) {
      const { fetch } = await run(ok)
      expect(fetch, ok).toHaveBeenCalledTimes(2)
    }
  })
})

describe('Secrets', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('are refused in read-only mode under any spelling', () => {
    vi.stubEnv('GATEWAY_READ_ONLY', 'true')
    for (const r of ['secret', 'Secrets', 'secrets.v1', 'secrets.v1.', 'pods,secrets', 'secret/x']) expect(() => refuseSecrets(r), r).toThrow('Secrets')
    for (const r of ['pods', 'externalsecrets.external-secrets.io', 'secretstores', 'configmap']) expect(() => refuseSecrets(r), r).not.toThrow()
  })
  it('are refused by kubectl_get and kubectl_describe themselves', async () => {
    vi.stubEnv('GATEWAY_READ_ONLY', 'true')
    for (const name of ['kubectl_get', 'kubectl_describe']) {
      const t = (kubernetesTools as unknown as Array<{ name: string; execute: (a: object) => Promise<string> }>).find(x => x.name === name)!
      expect(await t.execute({ resource: 'Secrets.v1.', name: 'x', namespace: 'management', output: 'yaml' })).toContain('Secrets are not readable')
    }
  })
  it('are as before on a writable gateway', () => {
    vi.stubEnv('GATEWAY_READ_ONLY', '')
    expect(() => refuseSecrets('secrets')).not.toThrow()
  })
})

describe('velero_describe_backup', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock('./run.js'); vi.resetModules() })
  it('asks for details, which writes a DownloadRequest, only on a writable gateway', async () => {
    const runOut = vi.fn(async (_bin: string, _args: string[]) => 'ok')
    vi.doMock('./run.js', () => ({ runOut, run: runOut }))
    vi.resetModules()
    const { backupTools: tools } = await import('../builtin-tools/backup.js')
    const t = (tools as unknown as Array<{ name: string; execute: (a: object) => Promise<string> }>).find(x => x.name === 'velero_describe_backup')!
    vi.stubEnv('GATEWAY_READ_ONLY', 'true')
    await t.execute({ name: 'b1' })
    vi.stubEnv('GATEWAY_READ_ONLY', '')
    await t.execute({ name: 'b1' })
    expect(runOut.mock.calls.map(c => c[1].includes('--details'))).toEqual([false, true])
  })
})

describe('knowledge_related', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('keeps noteId inside its path segment', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const t = (knowledgeGraphTools as unknown as Array<{ name: string; execute: (a: object) => Promise<string> }>).find(x => x.name === 'knowledge_related')!
    for (const noteId of ['../environments?x=1', 'a/b', 'a?b', '..']) expect(await t.execute({ noteId })).toContain("Invalid argument 'noteId'")
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('wiring', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  it('index.ts applies the mode wherever tools are registered or offered, and skips hooks, ArgoCD and /update', () => {
    const src = read('../index.ts')
    for (const part of [
      'READ_ONLY ? readOnlyBuiltins(tools) : tools) BUILTIN_REGISTRY[',
      'READ_ONLY ? readOnlyPolicy(tools, BUILTIN_REGISTRY) : tools)',
      'if (!READ_ONLY) {\n    hooksEngine = new HooksEngine(client)',
      'if (!READ_ONLY) {\n      bootstrapArgoCD(',
      "GATEWAY_TYPE === 'cluster' || READ_ONLY",
    ]) expect(src, part).toContain(part)
    expect(src.match(/BUILTIN_REGISTRY\[[^\]]+\] = /g)).toHaveLength(1)
    expect(src.match(/^ {2}activeTools = /gm)).toHaveLength(1)
    expect(src).not.toMatch(/activeTools\.(push|unshift|splice)\(/)
    expect(src.match(/new HooksEngine\(/g)).toHaveLength(1)
    expect(src.match(/bootstrapArgoCD\(/g)).toHaveLength(1)
  })
  it('covers every built-in tool module', () => {
    const names = new Set(all.map(t => t.name))
    for (const f of readdirSync(new URL('../builtin-tools/', import.meta.url)).filter(f => f.endsWith('.ts') && !f.includes('.test.'))) {
      for (const [, n] of read(`../builtin-tools/${f}`).matchAll(/^ {4}name: '([a-z_0-9]+)'/gm)) expect(names.has(n), `${f}: ${n}`).toBe(true)
    }
  })
})
