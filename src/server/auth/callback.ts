export type AuthCallbackPlan =
  | { kind: 'configuration_error' }
  | { kind: 'signin_error'; redirectUrl: string }
  | { kind: 'exchange'; code: string; successRedirectUrl: string; failureRedirectUrl: string };

export function configuredAppOrigin(value?: string | null) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export function planAuthCallback(requestUrl: string, appUrl?: string | null): AuthCallbackPlan {
  const request = new URL(requestUrl);
  const configuredOrigin = configuredAppOrigin(appUrl);
  const code = request.searchParams.get('code')?.trim();
  const failureOrigin = configuredOrigin ?? request.origin;

  if (!code) return { kind: 'signin_error', redirectUrl: `${failureOrigin}/?error=signin` };
  if (!configuredOrigin) return { kind: 'configuration_error' };

  return {
    kind: 'exchange',
    code,
    successRedirectUrl: `${configuredOrigin}/${request.searchParams.get('flow') === 'recovery' ? 'reset-password' : 'messenger'}`,
    failureRedirectUrl: `${configuredOrigin}/?error=signin`,
  };
}
