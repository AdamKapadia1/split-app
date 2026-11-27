import { reportClassifiedError } from '@/utils/sentry';

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
  'expo_push_token',
  'expo_access_token',
  'push_token',
]);

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const GBP = /£\s?\d+(?:\.\d{1,2})?/g;
const SORT_CODE = /\b\d{2}-\d{2}-\d{2}\b/g;
const LONG_DIGITS = /\d{8,}/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const SIGNED_STORAGE_URL = /https?:\/\/\S*\/object\/sign\/\S*/gi;
const TOKEN_PARAM = /([?&#]token=)[^\s&#]+/gi;
const EXPO_PUSH_TOKEN = /(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]*\]/g;

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
    .replace(EXPO_PUSH_TOKEN, REDACTED)
    .replace(TOKEN_PARAM, `$1${REDACTED}`)
    .replace(EMAIL, REDACTED)
    .replace(JWT, REDACTED)
    .replace(BEARER, REDACTED)
    .replace(GBP, REDACTED)
    .replace(SORT_CODE, REDACTED)
    .replace(LONG_DIGITS, REDACTED);
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Error);
}

function readLoggedError(args: unknown[]): unknown {
  for (const arg of args) {
    if (arg instanceof Error) return arg;
  }
  for (const arg of args) {
    if (isPlainRecord(arg) && 'error' in arg && arg.error != null) return arg.error;
  }
  for (const arg of args) {
    if (!isPlainRecord(arg)) continue;
    const name = typeof arg.name === 'string' && arg.name.trim() ? arg.name.trim() : 'Error';
    const code = typeof arg.code === 'string' || typeof arg.code === 'number' ? arg.code : undefined;
    return code === undefined ? { name } : { name, code };
  }
  return { name: 'Error' };
}

function readTelemetryHints(args: unknown[]) {
  const scope = args.find((arg): arg is string => typeof arg === 'string') ?? 'app';
  const record = args.find((arg): arg is Record<string, unknown> => isPlainRecord(arg));
  const operation = record && typeof record.operation === 'string' ? record.operation : 'unspecified';
  const unauthenticated = record?.unauthenticated === true;
  return { scope, operation, unauthenticated };
}

function reportHandledError(args: unknown[]) {
  if (isDev()) return;
  try {
    reportClassifiedError(readLoggedError(args), readTelemetryHints(args));
  } catch {
    // Crash reporting must never take down a handled error path.
  }
}

function emit(level: LogLevel, args: unknown[]) {
  if (!shouldEmitLog(level)) return;
  const sanitized = args.map((arg) => redactSensitive(arg));
  if (level === 'error') {
    reportHandledError(args);
    console.error(...sanitized);
  } else if (level === 'warn') console.warn(...sanitized);
  else console.log(...sanitized);
}

export const logger = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};
