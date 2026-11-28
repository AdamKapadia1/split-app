const FALLBACK = 'Something went wrong. Please try again.';

const LEAK = /relation |column |constraint |violates |syntax error|duplicate key|permission denied|stack|pg_|pgrst|sqlstate|jwt|bearer |sort[_ ]?code|account[_ ]?number|password|refresh_token|access_token|\/users\/|public\./i;

type ErrorRecord = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
  status?: unknown;
  originalError?: unknown;
};

/**
 * Codes that are safe to log: any 5-character PostgreSQL SQLSTATE
 * (`22023`, `57014`, `40P01`), PostgREST codes (`PGRST301`), and uppercase
 * symbolic codes (`FAILED`). Lowercase text, spaces, punctuation, and any
 * other length are rejected, so error text and PII never pass through.
 */
const SAFE_CODE = /^(?:[0-9A-Z]{5}|PGRST\d{3}|[A-Z][A-Z0-9_]{1,39})$/;

/**
 * A short machine code safe to log. Prefers the database SQLSTATE carried on
 * `originalError` over a service wrapper code. Never returns the error text.
 */
export function readSafeErrorCode(error: unknown, fallback = 'REQUEST_FAILED'): string {
  const nested = codeOf(isRecord(error) ? error.originalError : undefined);
  if (nested === '42501' || nested === '28000' || nested === 'PGRST301') return nested;
  const direct = codeOf(error);
  if (isSafeCode(direct)) return direct;
  if (isSafeCode(nested)) return nested;
  return fallback;
}

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

function isSafeCode(code: string) {
  return SAFE_CODE.test(code);
}

export function mapSettlementNudgeError(error: unknown, fallback = 'Could not send that reminder. Please try again.'): string {
  const code = readCode(error);
  if (code === 'NUDGE_COOLDOWN') return 'You already sent a reminder about this bill in the last 24 hours.';
  if (code === 'RATE_LIMITED') return 'You have sent too many reminders. Please try again in an hour.';
  if (code === 'RECIPIENT_OPTED_OUT') return 'This person has turned off settlement reminders.';
  if (code === 'NO_REGISTERED_DEVICE') return 'This person does not have notifications set up on a device yet.';
  if (code === 'NOTHING_OWED') return 'There is nothing unsettled to remind them about.';
  if (code === 'ALREADY_SETTLED') return 'This receipt is already marked settled.';
  if (code === 'NOT_AUTHORIZED') return 'You cannot send a reminder for this receipt.';
  if (code === 'PUSH_NOT_CONFIGURED') return 'Reminders are temporarily unavailable. Please try again later.';
  return mapErrorToUserMessage(error, fallback);
}

function isSafeMessage(message: string) {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 180) return false;
  if (LEAK.test(trimmed)) return false;
  if (/[{}[\]]/.test(trimmed)) return false;
  return true;
}
