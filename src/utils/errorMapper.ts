const FALLBACK = 'Something went wrong. Please try again.';

const LEAK = /relation |column |constraint |violates |syntax error|duplicate key|permission denied|stack|pg_|pgrst|sqlstate|jwt|bearer |sort[_ ]?code|account[_ ]?number|password|refresh_token|access_token|\/users\/|public\./i;

type ErrorRecord = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
  status?: unknown;
  originalError?: unknown;
};

export function mapErrorToUserMessage(error: unknown, fallback = FALLBACK): string {
  const code = readCode(error);
  const message = readMessage(error);

  if (code === '23505') return 'That is already saved.';
  if (code === '42501' || code === '28000' || code === 'PGRST301') return permissionOrSession(code);
  if (code === 'PGRST116') return 'We could not find that.';
  if (isTimeout(code, message, error)) return 'The request timed out. Check your connection and try again.';
  if (isAuth(code, message, error)) return 'Please sign in again.';
  if (isNetwork(message, error)) return 'Network problem. Check your connection and try again.';
  if (message && isSafeMessage(message)) return message;
  return fallback;
}

function permissionOrSession(code: string) {
  if (code === '42501') return 'You do not have permission to do that.';
  return 'Please sign in again.';
}

function readCode(error: unknown): string {
  const direct = codeOf(error);
  if (direct) return direct;
  if (isRecord(error) && 'originalError' in error) return codeOf(error.originalError);
  return '';
}

function codeOf(error: unknown): string {
  if (!isRecord(error) || error.code == null) return '';
  return String(error.code);
}

function readMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return '';
}

function isRecord(error: unknown): error is ErrorRecord {
  return Boolean(error) && typeof error === 'object';
}

function isTimeout(code: string, message: string, error: unknown) {
  if (code === '57014') return true;
  if (error instanceof Error && error.name === 'AbortError' && /timeout/i.test(message)) return true;
  return /timeout|timed out|etimedout/i.test(message);
}

function isAuth(code: string, message: string, error: unknown) {
  if (code === '401' || code === 'PGRST301' || code === '28000') return true;
  if (isRecord(error) && (error.status === 401 || error.status === '401')) return true;
  if (isRecord(error) && typeof error.name === 'string' && /auth/i.test(error.name) && /session|jwt|login|authenticated/i.test(message)) {
    return true;
  }
  return /not authenticated|invalid login|invalid jwt|jwt expired|session expired/i.test(message);
}

function isNetwork(message: string, error: unknown) {
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return true;
  return /network request failed|failed to fetch|network error|internet connection/i.test(message);
}

function isSafeMessage(message: string) {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 180) return false;
  if (LEAK.test(trimmed)) return false;
  if (/[{}[\]]/.test(trimmed)) return false;
  return true;
}
