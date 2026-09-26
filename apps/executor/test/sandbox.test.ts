import { describe, it, expect } from 'vitest'
import { parseArgv, checkAutoCommand, checkNotifyCommand, isBlockedPath } from '../src/command-policy.js'
import { Sandbox, runProcess, MAX_OUTPUT_BYTES, TIMEOUT_EXIT_CODE, FILE_READ_ALLOWLIST } from '../src/sandbox.js'

describe('parseArgv', () => {
  it('splits on whitespace and honours quotes and escapes', () => {
    expect(parseArgv(`grep -e 'a b' "c \\"d\\"" e\\ f`)).toEqual(['grep', '-e', 'a b', 'c "d"', 'e f'])
  })
  it.each(['a | b', 'a && b', 'a; b', 'a > f', 'a < f', 'echo $X', 'echo `id`', 'ls *', 'ls ~', "echo '$X'", 'a\nb', "unterminated 'quote"])(
    'refuses shell syntax: %s',
    cmd => expect(parseArgv(cmd)).toBeNull(),
  )
})

describe('command policy', () => {
  it('auto allowlist rejects binaries outside the list', () => {
    expect(checkAutoCommand(['env']).ok).toBe(false)
    expect(checkAutoCommand(['cat', '/etc/hosts']).ok).toBe(true)
  })
  it('notify refuses interpreters and env dumpers', () => {
    expect(checkNotifyCommand(['/usr/bin/env']).ok).toBe(false)
    expect(checkNotifyCommand(['python3.11', '-c', '1']).ok).toBe(false)
    expect(checkNotifyCommand(['systemctl', 'status', 'docker']).ok).toBe(true)
  })
  it('blocks /proc including via symlink and relative traversal', () => {
    expect(isBlockedPath('/proc/1/environ')).toBe(true)
    expect(isBlockedPath('/var/../proc/self/environ')).toBe(true)
    expect(isBlockedPath('/dev/fd/0')).toBe(true)
    expect(isBlockedPath('/var/log')).toBe(false)
    expect(isBlockedPath('/', true)).toBe(true)
    expect(isBlockedPath('/', false)).toBe(false)
  })
})

describe('runProcess', () => {
  it('runs argv without a shell', async () => {
    const r = await runProcess('echo', ['$HOME', '|', 'id'], 5000)
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('$HOME | id')
  })

  it('does not pass the executor environment to children', async () => {
    process.env.ORION_TEST_SECRET_TOKEN = 'should-not-leak'
    try {
      const r = await runProcess('env', [], 5000)
      expect(r.stdout).not.toContain('should-not-leak')
    } finally {
      delete process.env.ORION_TEST_SECRET_TOKEN
    }
  })

  it('returns a numeric exit code for a missing binary', async () => {
    const r = await runProcess('definitely-not-a-binary-xyz', [], 5000)
    expect(r.exitCode).toBe(127)
    expect(typeof r.exitCode).toBe('number')
  })

  it('returns non-zero exit codes as numbers', async () => {
    const r = await runProcess('sh', ['-c', 'exit 3'], 5000)
    expect(r.exitCode).toBe(3)
  })

  it('kills the whole process group on timeout', async () => {
    const start = Date.now()
    // The background sleep keeps the pipes open; without a group kill this would hang ~10s.
    const r = await runProcess('sh', ['-c', 'sleep 10 & sleep 10'], 300)
    expect(r.exitCode).toBe(TIMEOUT_EXIT_CODE)
    expect(r.stderr).toContain('timed out')
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('truncates large output with a marker', async () => {
    const r = await runProcess('head', ['-c', String(MAX_OUTPUT_BYTES * 2), '/dev/zero'], 10000)
    expect(r.stdout.length).toBeLessThan(MAX_OUTPUT_BYTES + 200)
    expect(r.stdout).toContain('[truncated')
  })
})

describe('Sandbox', () => {
  const sandbox = new Sandbox()

  it('refuses to run shell syntax unless explicitly allowed', async () => {
    const denied = await sandbox.execute('shell_exec', { command: 'echo a | cat' })
    expect(denied.exitCode).toBe(126)
    const allowed = await sandbox.execute('shell_exec', { command: 'echo a | cat' }, { allowShell: true })
    expect(allowed.stdout.trim()).toBe('a')
  })

  it('file_read allowlist no longer contains unreadable /proc entries', () => {
    expect(FILE_READ_ALLOWLIST.some(p => p.startsWith('/proc'))).toBe(false)
  })

  it('file_read rejects traversal out of the allowlist', async () => {
    const r = await sandbox.execute('file_read', { path: '/var/log/../../etc/shadow' })
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('not in the allowlist')
  })

  it('system_info returns JSON', async () => {
    const r = await sandbox.execute('system_info', {})
    expect(JSON.parse(r.stdout).cpus).toBeGreaterThan(0)
  })
})
