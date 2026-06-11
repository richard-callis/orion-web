// Edge-safe auth constants — no next-auth import, safe for middleware.ts
const IS_SECURE = process.env.NODE_ENV === 'production' || process.env.HEADER_X_FORWARDED_PROTO === 'https'
export const SESSION_COOKIE_NAME = IS_SECURE ? '__Secure-next-auth.session-token' : 'next-auth.session-token'
