import { describe, it, expect } from 'vitest'
import { isFileReadAllowed } from './localhost'

describe('isFileReadAllowed', () => {
  it.each(['/var/log/syslog', '/var/log/nginx/access.log', '/etc/hosts', '/proc/meminfo', '/var/log'])(
    'allows %s', p => expect(isFileReadAllowed(p)).toBe(true),
  )

  it.each([
    '/var/log/../../etc/shadow', // traversal out of an allowed prefix
    '/var/logx/secret',          // sibling sharing the prefix string
    '/etc/hosts.allow',          // exact-file entry is not a prefix
    '/etc/shadow',
    'var/log/syslog',            // relative
    '/var/log/\0/x',
  ])('rejects %s', p => expect(isFileReadAllowed(p)).toBe(false))
})
