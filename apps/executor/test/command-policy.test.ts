import { describe, it, expect } from 'vitest'
import { checkAutoCommand } from '../src/command-policy'

describe('checkAutoCommand — allowlist lookup', () => {
  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'])(
    'rejects Object.prototype member name %s',
    bin => {
      expect(checkAutoCommand([bin, 'x']).ok).toBe(false)
    },
  )

  it('still accepts a genuine allowlisted binary', () => {
    expect(checkAutoCommand(['uptime']).ok).toBe(true)
  })
})
