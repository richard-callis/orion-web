import type { OAuthConfig } from 'next-auth/providers/oauth'
import { prisma } from './db'

/**
 * Authentik OIDC login (authorization code + PKCE; NextAuth verifies the ID token).
 *
 * Config comes from env (injected by deploy/docker-compose.yml from deploy/.env):
 *   AUTHENTIK_OIDC_ISSUER         e.g. https://authentik.example.com/application/o/orion/
 *   AUTHENTIK_OIDC_CLIENT_ID
 *   AUTHENTIK_OIDC_CLIENT_SECRET  (secret — never stored in the DB, never logged)
 * Any of the three empty = provider off. OIDCProvider.enabled=false is a runtime kill
 * switch; OIDCProvider.groupMapping overrides the default group → role mapping.
 */

export type OrionRole = 'admin' | 'user' | 'readonly'
const ROLE_RANK: Record<OrionRole, number> = { readonly: 0, user: 1, admin: 2 }

export const DEFAULT_GROUP_ROLE = 'user' satisfies OrionRole
export const DEFAULT_GROUP_MAPPING: Record<string, OrionRole> = { 'authentik Admins': 'admin' }

export interface AuthentikConfig { issuer: string; clientId: string; clientSecret: string }

export function getAuthentikConfig(env: Record<string, string | undefined> = process.env): AuthentikConfig | null {
  const issuer = env.AUTHENTIK_OIDC_ISSUER?.trim()
  const clientId = env.AUTHENTIK_OIDC_CLIENT_ID?.trim()
  const clientSecret = env.AUTHENTIK_OIDC_CLIENT_SECRET?.trim()
  return issuer && clientId && clientSecret ? { issuer, clientId, clientSecret } : null
}

/** Highest-ranked role among the user's groups; DEFAULT_GROUP_ROLE when none match. */
export function mapGroupsToRole(groups: unknown, mapping: unknown): OrionRole {
  const map = mapping && typeof mapping === 'object' && !Array.isArray(mapping) && Object.keys(mapping).length
    ? (mapping as Record<string, unknown>)
    : DEFAULT_GROUP_MAPPING
  let best: OrionRole = DEFAULT_GROUP_ROLE
  for (const g of Array.isArray(groups) ? groups : []) {
    if (typeof g !== 'string' || !Object.hasOwn(map, g)) continue
    const role = map[g]
    if (typeof role === 'string' && role in ROLE_RANK && ROLE_RANK[role as OrionRole] > ROLE_RANK[best]) best = role as OrionRole
  }
  return best
}

export interface AuthentikClaims {
  sub: string
  email?: string
  email_verified?: boolean
  preferred_username?: string
  name?: string
  groups?: unknown
}

/** Provider is offered only when env is complete and the DB row (if any) is not disabled. */
export async function isAuthentikEnabled(): Promise<boolean> {
  if (!getAuthentikConfig()) return false
  const row = await prisma.oIDCProvider.findFirst({ select: { enabled: true } })
  return row ? row.enabled : true
}

export function authentikProviders(env: Record<string, string | undefined> = process.env): OAuthConfig<AuthentikClaims>[] {
  const cfg = getAuthentikConfig(env)
  if (!cfg) return []
  return [{
    id: 'authentik',
    name: 'Authentik',
    type: 'oauth',
    wellKnown: `${cfg.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`,
    authorization: { params: { scope: 'openid email profile groups' } },
    idToken: true,
    checks: ['pkce', 'state', 'nonce'],
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    // username/role are placeholders: the signIn callback replaces them with the resolved Orion user.
    profile: (p) => ({ id: p.sub, name: p.name ?? null, email: p.email ?? null, image: null, username: p.sub, role: 'user' }),
  }]
}

export type OidcLoginResult =
  | { ok: true; user: { id: string; username: string; email: string; name: string | null; role: OrionRole } }
  | { ok: false; reason: 'no_sub' | 'inactive' | 'account_conflict' }

/**
 * Resolve (and create/link) the Orion user for verified OIDC claims. Identity is the
 * stable `sub`; username/email changes at Authentik never re-point an existing link.
 * A first login links to an existing local user only by email when email_verified===true.
 * The role is recomputed from `groups` on every login.
 */
export async function resolveAuthentikUser(claims: AuthentikClaims, mapping: unknown): Promise<OidcLoginResult> {
  const sub = claims.sub
  if (typeof sub !== 'string' || !sub) return { ok: false, reason: 'no_sub' }
  const role = mapGroupsToRole(claims.groups, mapping)
  const name = claims.name ?? null
  const email = claims.email?.trim().toLowerCase()
  const now = new Date()

  let user = await prisma.user.findFirst({ where: { provider: 'authentik', externalId: sub } })
  if (!user && claims.email_verified === true && email) {
    const byEmail = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })
    if (byEmail) {
      // Already bound to some other external identity (incl. header-mode uid) — never re-bind.
      if (byEmail.externalId && byEmail.provider === 'authentik') return { ok: false, reason: 'account_conflict' }
      user = byEmail
    }
  }

  if (user) {
    if (!user.active) return { ok: false, reason: 'inactive' }
    // Link by sub only; keep passwordHash so local break-glass login still works.
    user = await prisma.user.update({
      where: { id: user.id },
      data: { provider: 'authentik', externalId: sub, role, lastSeen: now, ...(name ? { name } : {}) },
    })
  } else {
    const base = (claims.preferred_username || email?.split('@')[0] || `authentik-${sub.slice(0, 8)}`).slice(0, 60)
    let username = base
    for (let i = 2; await prisma.user.findUnique({ where: { username }, select: { id: true } }); i++) username = `${base}-${i}`
    user = await prisma.user.create({
      data: {
        username, name, role, provider: 'authentik', externalId: sub, lastSeen: now,
        // Unverified/missing email must not collide with (or claim) a real address.
        email: claims.email_verified === true && email ? email : `${sub}@oidc.invalid`,
      },
    })
  }
  return { ok: true, user: { id: user.id, username: user.username, email: user.email, name: user.name, role: user.role as OrionRole } }
}
