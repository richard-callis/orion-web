/**
 * Removes the NodePorts an existing LoadBalancer Service still holds once it
 * has allocateLoadBalancerNodePorts: false. Kubernetes never frees them by
 * itself, and neither `helm upgrade` nor `kubectl apply` removes them (they
 * were never in the applied manifest), so a re-bootstrapped Service would stay
 * reachable on every node's address. A Service still allocating NodePorts is
 * left alone: the API server would just assign new ones.
 */
export type ToolExec = (tool: string, args: Record<string, unknown>) => Promise<string>

/** JSON-patch ops that drop every port's nodePort, or [] when there is nothing to do. */
export function nodePortRemovalPatch(svc: unknown): Array<{ op: 'remove'; path: string }> {
  const spec = (svc as { spec?: { allocateLoadBalancerNodePorts?: boolean; ports?: Array<{ nodePort?: number }> } })?.spec
  if (!spec || spec.allocateLoadBalancerNodePorts !== false) return []
  return (spec.ports ?? []).flatMap((p, i) => (p?.nodePort ? [{ op: 'remove' as const, path: `/spec/ports/${i}/nodePort` }] : []))
}

/** Returns how many NodePorts were removed. */
export async function dropNodePorts(exec: ToolExec, name: string, namespace: string): Promise<number> {
  const svc = JSON.parse(await exec('kubectl_get', { resource: 'service', name, namespace, output: 'json' }))
  const ops = nodePortRemovalPatch(svc)
  if (ops.length === 0) return 0
  await exec('kubectl_patch', { resource: 'service', name, namespace, patchType: 'json', patch: JSON.stringify(ops) })
  return ops.length
}
