import { describe, it, expect } from 'vitest'
import { trivyTools } from './trivy.js'

const byName = Object.fromEntries(trivyTools.map((t) => [t.name, t]))

describe('trivy tool inputs validation', () => {
  it('trivy_scan_image rejects missing image', async () => {
    const result = await byName.trivy_scan_image.execute({})
    expect(String(result).toLowerCase()).toContain('required')
  })

  it('trivy_scan_image rejects shell-metachar image refs', async () => {
    const result = await byName.trivy_scan_image.execute({ image: 'foo;rm -rf /' })
    expect(String(result)).toContain('Invalid image ref')
  })

  it('trivy_scan_image rejects whitespace in image ref', async () => {
    const result = await byName.trivy_scan_image.execute({ image: 'foo bar' })
    expect(String(result)).toContain('Invalid image ref')
  })

  it('trivy_scan_image accepts well-formed image refs (would call trivy, but trivy may not be installed locally)', async () => {
    const result = await byName.trivy_scan_image.execute({ image: 'nginx:1.21' })
    // Either trivy is installed and we get JSON, or it's not and we get an error string.
    // Either way, the validation passed — we got past the regex check.
    expect(String(result)).not.toContain('Invalid image ref')
  })

  it('trivy_scan_k8s rejects shell-metachar namespace', async () => {
    const result = await byName.trivy_scan_k8s.execute({ namespace: '$(rm -rf /)' })
    expect(String(result)).toContain('Invalid namespace')
  })

  it('trivy_scan_k8s rejects uppercase namespace (DNS-1123 violation)', async () => {
    const result = await byName.trivy_scan_k8s.execute({ namespace: 'Default' })
    expect(String(result)).toContain('Invalid namespace')
  })

  it('trivy_scan_host takes no args', async () => {
    // Just confirm it can be invoked without args (will fail to find trivy locally,
    // but the validation layer must accept the call).
    const result = await byName.trivy_scan_host.execute({})
    expect(typeof result).toBe('string')
  })
})

describe('trivy tool metadata', () => {
  it('exports exactly three tools', () => {
    expect(trivyTools).toHaveLength(3)
    expect(byName).toHaveProperty('trivy_scan_image')
    expect(byName).toHaveProperty('trivy_scan_k8s')
    expect(byName).toHaveProperty('trivy_scan_host')
  })

  it('all tools are in the security category', () => {
    expect(trivyTools.every((t) => t.category === 'security')).toBe(true)
  })

  it('trivy_scan_image requires `image` in its input schema', () => {
    expect((byName.trivy_scan_image.inputSchema as any).required).toContain('image')
  })

  it('inputSchema is well-formed JSON Schema (object type)', () => {
    for (const tool of trivyTools) {
      expect((tool.inputSchema as any).type).toBe('object')
    }
  })
})
