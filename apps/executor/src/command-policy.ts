import fs from 'fs'
import os from 'os'
import path from 'path'

// Policy for commands that run WITHOUT a human approving them first (the "auto" and "notify"
// risk tiers). Those commands never touch a shell: they are tokenised into argv here and run
// via spawn() with no `/bin/sh -c`, so pipes, substitutions, globs and redirects cannot exist.
// Anything this module can't tokenise, or that reaches a blocked path, is escalated by the
// classifier to a human.

/** Working directory for every sandboxed command, and the base for resolving relative paths. */
export const EXEC_CWD = process.env.EXECUTOR_EXEC_CWD || os.tmpdir()

const DEFAULT_BLOCKED_PATHS = [
  '/proc', // /proc/<pid>/environ exposes the executor's own tokens
  '/sys',
  '/dev',
  '/run/secrets',
  '/var/run/secrets', // Kubernetes service-account token mount
  '/root',
  '/home',
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/sudoers',
  '/etc/sudoers.d',
]

export const BLOCKED_PATHS = [
  ...DEFAULT_BLOCKED_PATHS,
  ...(process.env.EXECUTOR_BLOCKED_PATHS || '').split(',').map(p => p.trim()).filter(Boolean),
].map(p => path.resolve(p))

// Characters that mean something to a shell. A command containing any of these (unquoted) was
// written for a shell, so running it as argv would silently change its meaning — reject it.
const UNQUOTED_SHELL_CHARS = new Set(['|', '&', ';', '<', '>', '(', ')', '$', '`', '*', '?', '[', ']', '{', '}', '~', '#', '!', '\n', '\r'])

/**
 * Tokenise a command string into argv using POSIX-like quoting (single quotes, double quotes,
 * backslash escapes) but with NO expansion of any kind. Returns null when the command relies on
 * shell features (operators, substitution, globbing, variables) and therefore can't be run
 * faithfully without a shell.
 */
export function parseArgv(command: string): string[] | null {
  if (typeof command !== 'string') return null
  // `$` and backticks are refused even inside quotes: a reader would expect them to expand.
  if (/[$`\n\r\0]/.test(command)) return null

  const argv: string[] = []
  let current = ''
  let inToken = false
  let i = 0
  while (i < command.length) {
    const ch = command[i]
    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        argv.push(current)
        current = ''
        inToken = false
      }
      i++
    } else if (ch === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return null
      current += command.slice(i + 1, end)
      inToken = true
      i = end + 1
    } else if (ch === '"') {
      i++
      let closed = false
      while (i < command.length) {
        const c = command[i]
        if (c === '"') { closed = true; i++; break }
        if (c === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) {
          current += command[i + 1]
          i += 2
          continue
        }
        current += c
        i++
      }
      if (!closed) return null
      inToken = true
    } else if (ch === '\\') {
      if (i + 1 >= command.length) return null
      current += command[i + 1]
      inToken = true
      i += 2
    } else if (UNQUOTED_SHELL_CHARS.has(ch)) {
      return null
    } else {
      current += ch
      inToken = true
      i++
    }
  }
  if (inToken) argv.push(current)
  return argv.length > 0 ? argv : null
}

export interface PolicyResult {
  ok: boolean
  reason?: string
}

/** Resolve a path relative to EXEC_CWD, following symlinks when the target exists. */
export function resolveRealPath(p: string, cwd: string = EXEC_CWD): string {
  const resolved = path.resolve(cwd, p)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function isUnder(target: string, prefix: string): boolean {
  return target === prefix || target.startsWith(prefix === '/' ? '/' : prefix + '/')
}

/**
 * True when `p` resolves into a blocked location. With `recursive`, ancestors of a blocked
 * location (e.g. `/` or `/run`) are also refused, because a recursive walk from there would
 * descend into it.
 */
export function isBlockedPath(p: string, recursive = false, cwd: string = EXEC_CWD): boolean {
  const candidates = new Set([path.resolve(cwd, p), resolveRealPath(p, cwd)])
  for (const target of candidates) {
    for (const blocked of BLOCKED_PATHS) {
      if (isUnder(target, blocked)) return true
      if (recursive && isUnder(blocked, target)) return true
    }
  }
  return false
}

/** Every string in argv that could name a file: plain args, `--opt=value`, and `-fPATH`. */
function pathCandidates(args: string[]): string[] {
  const out: string[] = []
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      out.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) out.push(arg.slice(eq + 1))
    const slash = arg.indexOf('/')
    if (slash !== -1) out.push(arg.slice(slash))
  }
  return out
}

/** Short-flag clusters such as `-Hc` contain the given letter. Long options are ignored. */
function hasShortFlag(args: string[], letter: string): boolean {
  return args.some(a => /^-[A-Za-z0-9]+$/.test(a) && a.slice(1).includes(letter))
}

function hasLongFlag(args: string[], ...names: string[]): boolean {
  return args.some(a => names.some(n => a === n || a.startsWith(n + '=')))
}

type BinaryRule = (args: string[]) => { reason?: string; recursive?: boolean }

const ok = (recursive = false) => ({ recursive })
const deny = (reason: string) => ({ reason })

// Binaries allowed on the auto tier, with per-binary argument restrictions. Anything that can
// write, delete, execute another program, change system state or print the environment is
// refused here and goes to a human instead.
export const AUTO_BINARIES: Record<string, BinaryRule> = {
  ls: args => ok(hasShortFlag(args, 'R') || hasLongFlag(args, '--recursive')),
  cat: () => ok(),
  head: () => ok(),
  tail: () => ok(),
  wc: () => ok(),
  stat: () => ok(),
  df: () => ok(),
  free: () => ok(),
  uptime: () => ok(),
  pwd: () => ok(),
  which: () => ok(),
  id: () => ok(),
  whoami: () => ok(),
  uname: () => ok(),
  lsof: () => ok(),
  netstat: () => ok(),
  grep: args => {
    // -R follows every symlink during the walk, which can lead out of an allowed tree.
    if (hasShortFlag(args, 'R') || hasLongFlag(args, '--dereference-recursive')) {
      return deny('grep -R follows symlinks; use -r')
    }
    return ok(hasShortFlag(args, 'r') || hasLongFlag(args, '--recursive', '--directories'))
  },
  find: args => {
    const forbidden = ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-L', '-H', '-follow']
    const hit = args.find(a => forbidden.includes(a))
    return hit ? deny(`find ${hit} is not allowed without approval`) : ok(true)
  },
  du: args => {
    if (hasShortFlag(args, 'L') || hasLongFlag(args, '--dereference')) return deny('du -L follows symlinks')
    return ok(true)
  },
  ps: args => {
    // BSD-style `ps e` / `ps aux e` / `ps eww` prints every process's environment.
    const bsdEnv = args.some(a => !a.startsWith('-') && a.includes('e'))
    return bsdEnv ? deny('ps with the BSD "e" option prints process environments') : ok()
  },
  ss: args => (hasShortFlag(args, 'K') || hasLongFlag(args, '--kill') ? deny('ss -K kills sockets') : ok()),
  hostname: args => {
    const allowed = new Set(['-f', '-s', '-i', '-I', '-d', '-A', '--fqdn', '--short', '--ip-address', '--all-ip-addresses', '--domain'])
    return args.every(a => allowed.has(a)) ? ok() : deny('hostname may only be queried, not set')
  },
  date: args => {
    if (hasShortFlag(args, 's') || hasLongFlag(args, '--set')) return deny('date --set changes the clock')
    if (args.some(a => !a.startsWith('-') && !a.startsWith('+'))) return deny('date with a positional argument sets the clock')
    return ok()
  },
  journalctl: args => {
    const forbidden = ['--vacuum-size', '--vacuum-time', '--vacuum-files', '--rotate', '--flush', '--sync',
      '--relinquish-var', '--smart-relinquish-var', '--setup-keys', '--update-catalog', '--cursor-file']
    return hasLongFlag(args, ...forbidden) ? deny('journalctl option modifies the journal') : ok()
  },
  dmesg: args => {
    const clears = ['c', 'C', 'D', 'E', 'n'].some(l => hasShortFlag(args, l))
    const longClears = hasLongFlag(args, '--clear', '--read-clear', '--console-off', '--console-on', '--console-level')
    return clears || longClears ? deny('dmesg option modifies the kernel log') : ok()
  },
}

// Binaries that are never acceptable without approval, even on an admin-authored notify rule:
// interpreters and anything that prints or rewrites the environment.
const NEVER_UNATTENDED = new Set([
  'env', 'printenv', 'set', 'export', 'declare', 'compgen',
  'sh', 'bash', 'dash', 'zsh', 'ash', 'busybox', 'node', 'python', 'python3', 'perl', 'ruby', 'php',
  'xargs', 'nohup', 'timeout', 'nice', 'sudo', 'su', 'doas',
])

function checkPaths(args: string[], recursive: boolean): PolicyResult {
  for (const candidate of pathCandidates(args)) {
    if (isBlockedPath(candidate, recursive)) {
      return { ok: false, reason: `argument '${candidate}' reaches a blocked path` }
    }
  }
  return { ok: true }
}

const AUTO_RULES: ReadonlyMap<string, BinaryRule> = new Map(Object.entries(AUTO_BINARIES))

function binaryName(argv0: string): string {
  return path.basename(argv0)
}

/** Policy for the auto tier: allowlisted binary, permitted flags, no blocked paths. */
export function checkAutoCommand(argv: string[]): PolicyResult {
  const [bin, ...args] = argv
  // Only bare names: an explicit path could point at a different binary with the same name.
  if (bin.includes('/')) return { ok: false, reason: 'auto commands must use a bare binary name' }
  // Map lookup: an object index would resolve 'constructor', 'toString',
  // '__proto__' etc. to Object.prototype members and pass them as rules.
  const rule = AUTO_RULES.get(bin)
  if (!rule) return { ok: false, reason: `'${bin}' is not on the auto allowlist` }
  if (typeof rule !== 'function') return { ok: false, reason: `'${bin}' rule is invalid` }
  const verdict = rule(args)
  if (verdict.reason) return { ok: false, reason: verdict.reason }
  return checkPaths(args, verdict.recursive ?? false)
}

/** Policy for the notify tier: any binary except interpreters/env dumpers, no blocked paths. */
export function checkNotifyCommand(argv: string[]): PolicyResult {
  const [bin, ...args] = argv
  const name = binaryName(bin)
  if (NEVER_UNATTENDED.has(name) || /^python[0-9.]*$/.test(name)) {
    return { ok: false, reason: `'${name}' cannot run without approval` }
  }
  // A notify-tier binary isn't vetted like the auto list, so assume it may walk directories.
  // The binary itself is checked too (e.g. /proc/self/exe is the executor's own node binary).
  return checkPaths([bin, ...args], true)
}
