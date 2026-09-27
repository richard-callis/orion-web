import { describe, it, expect } from 'vitest'
import { ApiException } from '@kubernetes/client-node'
import { k8sStatusCode, isK8sConflict, isK8sNotFound } from './k8s-errors'

describe('k8sStatusCode', () => {
  it('reads ApiException.code (client-node >= 1.0)', () => {
    const e = new ApiException(409, 'Conflict', { reason: 'Conflict' }, {})
    expect(k8sStatusCode(e)).toBe(409)
    expect(isK8sConflict(e)).toBe(true)
    expect(isK8sNotFound(e)).toBe(false)
  })

  it('reads 404 from ApiException', () => {
    expect(isK8sNotFound(new ApiException(404, 'Not Found', {}, {}))).toBe(true)
  })

  it('still accepts the legacy 0.x shape', () => {
    expect(k8sStatusCode({ response: { statusCode: 409 } })).toBe(409)
    expect(k8sStatusCode({ statusCode: 404 })).toBe(404)
    expect(k8sStatusCode({ body: { code: 403 } })).toBe(403)
  })

  it('ignores non-HTTP codes and non-objects', () => {
    expect(k8sStatusCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBeUndefined()
    expect(k8sStatusCode(new Error('plain'))).toBeUndefined()
    expect(k8sStatusCode(null)).toBeUndefined()
    expect(k8sStatusCode('409')).toBeUndefined()
  })
})
