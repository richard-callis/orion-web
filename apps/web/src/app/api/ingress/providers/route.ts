/**
 * GET /api/ingress/providers
 *
 * Returns all available SSO provider nova configs — bundled + remote (orion-nub).
 * Used by the SSO bootstrap modal to dynamically populate the provider selector.
 */
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { BUNDLED_PROVIDERS, loadRemoteManifest, loadRemoteConfig } from '@/lib/provider-engine'

interface ProviderListItem {
  name: string
  displayName: string
  description: string
  source?: 'bundled' | 'remote' | 'local'
  hasHelm?: boolean
  hasOverlaySecret?: boolean
  hasCleanup?: boolean
  fields?: string[]
}

// Hardcoded fallbacks for providers without JSON configs yet
const HARDCODED_PROVIDERS: Record<string, ProviderListItem> = {
  oauth2_proxy: {
    name: 'oauth2_proxy',
    displayName: 'OAuth2 Proxy',
    description: 'Lightweight OIDC proxy (requires external provider)',
    fields: ['hostname','oidcIssuerUrl','clientId','clientSecret','namespace'],
  },
  keycloak: {
    name: 'keycloak',
    displayName: 'Keycloak',
    description: 'Enterprise identity & access management (RH SSO)',
    fields: ['hostname','adminPassword','namespace','clusterIssuer'],
  },
  custom_oidc: {
    name: 'custom_oidc',
    displayName: 'Custom OIDC',
    description: 'Generic OpenID Connect provider (any compliant server)',
    fields: ['hostname','oidcIssuerUrl','clientId','clientSecret','customIssuerCaSecret','namespace'],
  },
}

export async function GET() {
  try { await requireAdmin() } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Build merged list: bundled JSON providers + hardcoded fallbacks
  const providers = new Map<string, ProviderListItem>()

  // Add bundled JSON providers
  for (const [name, meta] of Object.entries(BUNDLED_PROVIDERS)) {
    providers.set(name, {
      name: meta.name,
      displayName: meta.displayName,
      description: meta.description,
      source: 'bundled' as const,
      hasHelm: !!meta.helm,
      hasOverlaySecret: !!meta.overlaySecret,
      hasCleanup: !!meta.cleanup,
    })
  }

  // Try loading remote configs (non-blocking — skip on failure)
  try {
    const manifest = await loadRemoteManifest()
    if (manifest) {
      for (const p of manifest.providers) {
        const config = await loadRemoteConfig(p.name)
        if (config && !providers.has(p.name)) {
          providers.set(p.name, {
            name: p.name,
            displayName: p.displayName,
            description: p.description,
            source: 'remote' as const,
            hasHelm: !!config.helm,
            hasOverlaySecret: !!config.overlaySecret,
            hasCleanup: !!config.cleanup,
          })
        }
      }
    }
  } catch { /* remote unavailable — bundled only */ }

  // Add hardcoded fallbacks (only if not already present)
  for (const [name, meta] of Object.entries(HARDCODED_PROVIDERS)) {
    if (!providers.has(name)) {
      providers.set(name, { ...meta, source: 'local' })
    }
  }

  return NextResponse.json({
    providers: Array.from(providers.values()),
    source: 'remote',
  })
}
