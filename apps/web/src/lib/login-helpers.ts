/**
 * Same-origin path check for post-login redirects. Rejects protocol-relative ('//x'),
 * backslash ('/\x', which browsers treat as '//') and control-character ('/\t/x') forms.
 */
export function safeCallbackPath(url: string | null | undefined, fallback = '/'): string {
  if (typeof url !== 'string') return fallback
  return /^\/(?![/\\])/.test(url) && !/[\\\x00-\x1f\x7f]/.test(url) ? url : fallback
}

/** User-facing message for a NextAuth `?error=` code on /login. Never echoes the raw value. */
export function loginErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case null:
    case undefined:
    case '':
      return ''
    case 'AccessDenied':
      return 'Your Authentik account is not allowed to sign in to Orion (disabled or linked to another account). Contact an admin.'
    case 'AuthentikDisabled':
      return 'Authentik sign-in is disabled; use a local account.'
    case 'OAuthSignin':
    case 'OAuthCallback':
    case 'Callback':
      return 'Sign-in with Authentik failed. Try again or use a local account.'
    default:
      return 'Sign-in failed. Try again or use a local account.'
  }
}
