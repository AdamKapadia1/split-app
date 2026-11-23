export const AI_SCAN_CONSENT_KEY = 'splitapp.ai_scan_consent';

export function isLegacyAuthStorageKey(key: string) {
  return /^sb-[A-Za-z0-9_-]+-auth-token(?:\.\d+)?$/.test(key) || key === 'supabase.auth.token';
}

export function isAppOwnedStorageKey(key: string) {
  return key.startsWith('splitapp.') || isLegacyAuthStorageKey(key);
}
