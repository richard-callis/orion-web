export interface HostConnection {
  host: string        // hostname or IP
  port?: number       // SSH port (default 22)
  user: string        // SSH user
  keyPath?: string    // path to SSH key (or use SSH agent)
}

/**
 * Validate values that will be interpolated into remote shell commands via SSH/SCP.
 * These fields come from user-supplied environment metadata; without validation
 * a crafted value like user='-oProxyCommand=...' causes SSH option injection,
 * and remotePath='/opt; rm -rf /' causes RCE on the remote host.
 */
export function validateSshField(value: string, name: string, pattern: RegExp): string {
  if (!pattern.test(value)) {
    throw new Error(`Invalid ${name} value '${value}' — must match ${pattern}`)
  }
  return value
}

/** Parse host connection from environment metadata. */
export function parseHostConnection(env: { metadata: unknown; id: string }): HostConnection {
  const meta = env.metadata as Record<string, unknown> | undefined
  const rawHost  = (meta?.host     as string) ?? 'localhost'
  const rawUser  = (meta?.sshUser  as string) ?? 'root'
  const rawPort  = Number((meta?.sshPort as unknown) ?? 22)
  const keyPath  = meta?.sshKeyPath as string | undefined

  // Validate sshKeyPath contains only safe path characters
  const SSH_KEY_PATH_RE = /^[a-zA-Z0-9/_.-]+$/
  if (keyPath && !SSH_KEY_PATH_RE.test(keyPath)) {
    throw new Error('Invalid sshKeyPath')
  }

  // Validate before interpolating into SSH/SCP commands
  const host = validateSshField(rawHost,  'host',    /^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,252}[a-zA-Z0-9])?$/)
  const user = validateSshField(rawUser,  'sshUser', /^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,31}$/)
  if (!Number.isFinite(rawPort) || rawPort < 1 || rawPort > 65535) {
    throw new Error(`Invalid sshPort: ${rawPort}`)
  }
  const port = rawPort
  return { host, port, user, keyPath }
}
