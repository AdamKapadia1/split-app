export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
export const EXPO_PUSH_CHUNK = 100;
export const EXPO_RECEIPT_CHUNK = 1000;
const MAX_ATTEMPTS = 3;
const PUSH_TIMEOUT_MS = 15_000;

export type ExpoTicket = {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string };
};

export type ExpoReceipt = {
  status?: string;
  message?: string;
  details?: { error?: string };
};

export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export async function postExpo<T>(url: string, accessToken: string, body: unknown): Promise<T> {
  let delayMs = 200;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`expo_http_${response.status}`);
        if (attempt === MAX_ATTEMPTS) throw lastError;
        await sleep(delayMs);
        delayMs *= 2;
        continue;
      }
      if (!response.ok) {
        throw new Error(`expo_http_${response.status}`);
      }
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.message.startsWith('expo_http_429') || error.message.startsWith('expo_http_5') || isNetworkError(error));
      const httpTerminal = error instanceof Error && /^expo_http_4/.test(error.message) && !error.message.startsWith('expo_http_429');
      if (httpTerminal || attempt === MAX_ATTEMPTS || !retryable) throw error;
      await sleep(delayMs);
      delayMs *= 2;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('expo_push_failed');
}

export function safeErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/(ExponentPushToken|ExpoPushToken)\[[^\]]*\]/g, '[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return cleaned || null;
}

export async function tokenKeyPrefix(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isNetworkError(error: Error): boolean {
  return error.name === 'TypeError' || error.message === 'network error' || error.message.includes('client error');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
