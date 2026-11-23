const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

const SENSITIVE_KEYS = new Set([
  'sort_code',
  'account_number',
  'bank_sort_code',
  'bank_account_number',
  'email',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'signed_url',
  'signedurl',
  'signed_token',
]);

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const SIGNED_STORAGE_URL = /https?:\/\/\S*\/object\/sign\/\S*/gi;
const TOKEN_PARAM = /([?&#]token=)[^\s&#]+/gi;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function isDev() {
  return typeof globalThis !== 'undefined' && (globalThis as { __DEV__?: boolean }).__DEV__ === true;
}

export function shouldEmitLog(level: LogLevel) {
  if (level === 'warn' || level === 'error') return true;
  return isDev();
}

export function redactString(value: string) {
  return value
    .replace(SIGNED_STORAGE_URL, REDACTED)
    .replace(TOKEN_PARAM, `$1${REDACTED}`)
    .replace(EMAIL, REDACTED)
    .replace(JWT, REDACTED)
    .replace(BEARER, REDACTED);
}

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (value instanceof Error) {
    return { name: value.name || 'Error', message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? REDACTED : redactSensitive(nested, depth + 1);
    }
    return output;
  }
  return REDACTED;
}

function emit(level: LogLevel, args: unknown[]) {
  if (!shouldEmitLog(level)) return;
  const sanitized = args.map((arg) => redactSensitive(arg));
  if (level === 'error') console.error(...sanitized);
  else if (level === 'warn') console.warn(...sanitized);
  else console.log(...sanitized);
}

export const logger = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};
