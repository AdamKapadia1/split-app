const CANONICAL_ORIGIN = 'https://velor-pay.vercel.app';

type Env = Record<string, string | undefined>;

/**
 * Canonical web origin for share links, auth redirects, and link previews.
 * Production rejects any non-https value and uses https://velor-pay.vercel.app.
 */
export function getWebBaseUrl(env: Env = process.env): string {
  const configured = firstConfigured(env.EXPO_PUBLIC_WEB_URL, env.EXPO_PUBLIC_WEB_BASE_URL);
  const canonical = canonicalize(configured);
  if (!canonical) return CANONICAL_ORIGIN;
  if (isProduction(env) && !canonical.startsWith('https://')) return CANONICAL_ORIGIN;
  return canonical;
}

function firstConfigured(...values: (string | undefined)[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production' || env.EXPO_PUBLIC_APP_ENV === 'production';
}

function canonicalize(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}
