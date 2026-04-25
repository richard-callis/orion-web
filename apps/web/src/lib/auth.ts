import { getServerSession, type NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { compare } from 'bcryptjs'
import { prisma } from './db'

export interface AppUser {
  id: string
  username: string
  email: string
  name: string | null
  role: string
  active: boolean
}

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,
  // SOC2: [M-002] secure flag is now conditional — true behind TLS (prod/reverse-proxy),
  // false only for local dev over plain HTTP. The __Secure- prefix is used when secure=true
  // so browsers will not send cookies on insecure requests.
  cookies: {
    sessionToken: {
      name: process.env.NODE_ENV === 'production' || process.env.HEADER_X_FORWARDED_PROTO === 'https'
        ? '__Secure-next-auth.session-token'
        : 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax' as const,
        path: '/',
        secure: process.env.NODE_ENV === 'production' || process.env.HEADER_X_FORWARDED_PROTO === 'https',
      },
    },
    callbackUrl: {
      name: process.env.NODE_ENV === 'production' || process.env.HEADER_X_FORWARDED_PROTO === 'https'
        ? '__Secure-next-auth.callback-url'
        : 'next-auth.callback-url',
      options: {
        sameSite: 'lax' as const,
        path: '/',
        secure: process.env.NODE_ENV === 'production' || process.env.HEADER_X_FORWARDED_PROTO === 'https',
      },
    },
    csrfToken: {
      name: process.env.NODE_ENV === 'production' || process.env.HEADER_X_FORWARDED_PROTO === 'https'
        ? '__Secure-next-auth.csrf-token'
        : 'next-auth.csrf-token',
      options: {
        httpOnly: true,
        sameSite: 'lax' as const,
        path: '/',
        secure: process.env.NODE_ENV === 'production' || process.env.HEADER_X_FORWARDED_PROTO === 'https',
      },
    },
  },
  pages: {
    signIn: '/login',
  },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        username: { label: 'Username', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null

        const user = await prisma.user.findUnique({
          where: { username: credentials.username },
        })

        if (!user || !user.active || !user.passwordHash) return null

        const valid = await compare(credentials.password, user.passwordHash)
        if (!valid) return null

        await prisma.user.update({
          where: { id: user.id },
          data: { lastSeen: new Date() },
        })

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          username: user.username,
          role: user.role,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Fresh login — populate token from the authorized user object
        token.sub = user.id
        token.username = (user as AppUser & { username: string }).username
        token.role = (user as AppUser & { role: string }).role
      } else if (token.sub) {
        // Subsequent requests — verify the user still exists in the DB.
        // If the DB was wiped the user row is gone, so we invalidate the token
        // by clearing sub. Middleware treats token without sub as unauthenticated.
        const dbUser = await prisma.user.findUnique({
          where: { id: token.sub },
          select: { id: true, active: true },
        })
        if (!dbUser || !dbUser.active) {
          token.sub = undefined
        }
      }
      return token
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub as string
        session.user.username = token.username as string
        session.user.role = token.role as string
      }
      return session
    },
  },
}

export async function getCurrentUser(): Promise<AppUser | null> {
  // Primary: NextAuth JWT session
  const session = await getServerSession(authOptions)
  if (session?.user) {
    return {
      id: session.user.id,
      username: session.user.username,
      email: session.user.email ?? '',
      name: session.user.name ?? null,
      role: session.user.role,
      active: true,
    }
  }

  // Optional SSO fallback: header-based (only if OIDCProvider.headerMode is enabled)
  try {
    const { headers } = await import('next/headers')
    const h = headers()
    const username = h.get('x-authentik-username') ?? h.get('x-forwarded-user')
    if (username) {
      const ssoProvider = await prisma.oIDCProvider.findFirst()
      if (ssoProvider?.enabled && ssoProvider?.headerMode) {
        const user = await prisma.user.upsert({
          where: { username },
          update: { lastSeen: new Date() },
          create: {
            username,
            email: h.get('x-authentik-email') ?? `${username}@sso`,
            name: h.get('x-authentik-name'),
            externalId: h.get('x-authentik-uid'),
            role: 'user',
            provider: 'authentik',
          },
        })
        if (!user.active) return null
        return user
      }
    }
  } catch {
    // Headers not available in this context — skip SSO fallback
  }

  return null
}

export async function requireAdmin(): Promise<AppUser> {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') {
    throw new Error('Unauthorized')
  }
  return user
}
