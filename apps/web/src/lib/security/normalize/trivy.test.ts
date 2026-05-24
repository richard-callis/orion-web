import { describe, it, expect } from 'vitest'
import { parseTrivyImageOutput, parseTrivyK8sOutput } from './trivy'

describe('parseTrivyImageOutput', () => {
  it('extracts vulnerabilities with V3 score from nvd', () => {
    const json = JSON.stringify({
      Results: [
        {
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-2021-44228',
              PkgName: 'log4j-core',
              InstalledVersion: '2.14.0',
              FixedVersion: '2.17.0',
              CVSS: {
                nvd: { V3Score: 10.0, V3Vector: 'CVSS:3.1/AV:N/AC:L' },
              },
            },
          ],
        },
      ],
    })
    const out = parseTrivyImageOutput(json, 'env_1', 'image:foo:bar')
    expect(out).toHaveLength(1)
    expect(out[0].cveId).toBe('CVE-2021-44228')
    expect(out[0].cvssScore).toBe(10.0)
    expect(out[0].severity).toBe(100) // 10 * 10 = 100
    expect(out[0].fixedVersion).toBe('2.17.0')
  })

  it('falls back to redhat then ghsa when nvd score missing', () => {
    const json = JSON.stringify({
      Results: [
        {
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-X',
              PkgName: 'foo',
              CVSS: { redhat: { V3Score: 7.5 } },
            },
          ],
        },
      ],
    })
    expect(parseTrivyImageOutput(json, 'env', 'image:x').cvssScore = parseTrivyImageOutput(json, 'env', 'image:x')[0].cvssScore).toBe(7.5)
  })

  it('handles missing CVSS gracefully — severity 0', () => {
    const json = JSON.stringify({
      Results: [{ Vulnerabilities: [{ VulnerabilityID: 'CVE-Y', PkgName: 'bar' }] }],
    })
    const out = parseTrivyImageOutput(json, 'env', 'image:y')
    expect(out[0].cvssScore).toBeNull()
    expect(out[0].severity).toBe(0)
  })

  it('returns empty array for malformed JSON', () => {
    expect(parseTrivyImageOutput('not-json', 'env', 'image:x')).toEqual([])
  })

  it('skips entries missing VulnerabilityID or PkgName', () => {
    const json = JSON.stringify({
      Results: [
        {
          Vulnerabilities: [
            { VulnerabilityID: 'CVE-A', PkgName: 'ok' },
            { VulnerabilityID: '', PkgName: 'skip' },
            { PkgName: 'skip-no-id' },
            { VulnerabilityID: 'CVE-B' },
          ],
        },
      ],
    })
    const out = parseTrivyImageOutput(json, 'env', 'image:foo')
    expect(out).toHaveLength(1)
    expect(out[0].cveId).toBe('CVE-A')
  })

  it('preserves environmentId and target on every row', () => {
    const json = JSON.stringify({
      Results: [
        {
          Vulnerabilities: [
            { VulnerabilityID: 'CVE-1', PkgName: 'a' },
            { VulnerabilityID: 'CVE-2', PkgName: 'b' },
          ],
        },
      ],
    })
    const out = parseTrivyImageOutput(json, 'env_42', 'image:libssl:1.1')
    expect(out.every((c) => c.environmentId === 'env_42')).toBe(true)
    expect(out.every((c) => c.target === 'image:libssl:1.1')).toBe(true)
  })
})

describe('parseTrivyK8sOutput', () => {
  it('extracts misconfigurations with severity mapping', () => {
    const json = JSON.stringify({
      Resources: [
        {
          Namespace: 'kube-system',
          Kind: 'Pod',
          Name: 'risky-pod',
          Misconfigurations: [
            {
              ID: 'KSV017',
              Title: 'Privileged container',
              Description: 'Pod has privileged: true',
              Severity: 'HIGH',
            },
          ],
        },
      ],
    })
    const out = parseTrivyK8sOutput(json, 'env_1')
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('trivy.ksv017')
    expect(out[0].severity).toBe(70)
    expect(out[0].sourceName).toBe('Pod/risky-pod')
    expect(out[0].title).toContain('Privileged container')
  })

  it('maps CRITICAL=90, HIGH=70, MEDIUM=50, LOW=25, other=10', () => {
    const make = (sev: string) =>
      parseTrivyK8sOutput(
        JSON.stringify({
          Resources: [{ Kind: 'Pod', Name: 'p', Misconfigurations: [{ ID: 'X', Title: 'T', Severity: sev }] }],
        }),
        'e'
      )[0].severity
    expect(make('CRITICAL')).toBe(90)
    expect(make('HIGH')).toBe(70)
    expect(make('MEDIUM')).toBe(50)
    expect(make('LOW')).toBe(25)
    expect(make('UNKNOWN')).toBe(10)
  })

  it('returns empty array on malformed JSON', () => {
    expect(parseTrivyK8sOutput('{not json', 'env')).toEqual([])
  })

  it('skips entries with missing ID', () => {
    const json = JSON.stringify({
      Resources: [
        {
          Kind: 'Pod',
          Name: 'p',
          Misconfigurations: [{ ID: '', Title: 'skip' }, { ID: 'OK', Title: 'keep' }],
        },
      ],
    })
    const out = parseTrivyK8sOutput(json, 'e')
    expect(out).toHaveLength(1)
    expect(out[0].rawEvent).toMatchObject({ ID: 'OK' })
  })
})
