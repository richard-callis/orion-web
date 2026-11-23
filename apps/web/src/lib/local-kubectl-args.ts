/**
 * kubectl argv for the local runners (used when the environment's gateway can't
 * do the work), shaped like the gateway's tools of the same
 * name take their args. Returns null for a tool it does not handle. The caller
 * runs it with execFile (no shell) and appends --kubeconfig.
 */
export function localKubectlArgs(name: string, args: Record<string, unknown>): string[] | null {
  const ns = args.namespace ? ['-n', String(args.namespace)] : []
  switch (name) {
    case 'kubectl_get':
      return ['get', String(args.resource), ...(args.name ? [String(args.name)] : []), ...ns,
        '-o', args.output ? String(args.output) : 'wide']
    case 'kubectl_patch':
      return ['patch', String(args.resource), String(args.name), ...ns,
        `--type=${args.patchType === 'json' ? 'json' : args.patchType === 'strategic' ? 'strategic' : 'merge'}`,
        `--patch=${String(args.patch ?? '')}`]
    case 'kubectl_rollout_status':
      return ['rollout', 'status', `${String(args.kind)}/${String(args.name)}`, ...ns,
        `--timeout=${args.timeout ?? '120s'}`]
    default:
      return null
  }
}
