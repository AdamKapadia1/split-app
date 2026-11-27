export type TelemetryAction = 'ignore' | 'breadcrumb' | 'capture';

export type TelemetryHints = {
  scope?: unknown;
  operation?: unknown;
  unauthenticated?: boolean;
};

export type ClassifiedTelemetry = {
  action: TelemetryAction;
  scope: string;
  operation: string;
  error_code: string;
  error_name: string;
  http_status?: number;
  fingerprint: readonly [string, string, string, string];
  syntheticMessage: string;
};

export const TELEMETRY_BURST_WINDOW_MS = 60_000;
export const TELEMETRY_BURST_LIMIT = 100;

const ERROR_CODE = /^[A-Z0-9_-]{1,24}$/i;
const SCOPE = /^[a-z0-9]{1,24}$/;
const OPERATION = /^[a-z0-9]+(?:\.[a-z0-9]+){0,6}$/i;
const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g;
const GBP = /£\s?\d+(?:\.\d{1,2})?/g;
const SORT_CODE = /\b\d{2}-\d{2}-\d{2}\b/g;
const LONG_DIGITS = /\d{8,}/g;
const ABORT = /aborted|canceled|cancelled/i;
const AUTH_MISSING = /auth session missing/i;
const TRANSIENT = /network request failed|failed to fetch|the internet connection appears to be offline|the network connection was lost|software caused connection abort/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function scrubTelemetryString(value: string): string {
  return value
    .replace(EMAIL, '[redacted]')
    .replace(JWT, '[redacted]')
    .replace(GBP, '[redacted]')
    .replace(SORT_CODE, '[redacted]')
    .replace(LONG_DIGITS, '[redacted]');
}

export function telemetryBurstKey(classified: Pick<ClassifiedTelemetry, 'scope' | 'operation' | 'error_code'>): string {
  return `${classified.scope}:${classified.operation}:${classified.error_code}`;
}

/** Pure window check. The caller owns the bounded map. */
export function decideBurst(
  previousCapturedAt: number | undefined,
  now: number,
  windowMs = TELEMETRY_BURST_WINDOW_MS,
): 'capture' | 'breadcrumb' {
  if (previousCapturedAt != null && now - previousCapturedAt < windowMs) return 'breadcrumb';
  return 'capture';
}

function readMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return '';
}

function readCode(error: unknown): string {
  if (!isRecord(error) || error.code == null) return '';
  if (typeof error.code === 'string' || typeof error.code === 'number') return String(error.code).trim();
  return '';
}

function readName(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name.trim();
  if (isRecord(error) && typeof error.name === 'string' && error.name.trim()) return error.name.trim();
  return 'Error';
}

function readStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const raw = error.status ?? error.statusCode;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{3}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 400 || parsed > 599) return undefined;
  return parsed;
}

function normalizeScope(value: unknown): string {
  if (typeof value !== 'string') return 'app';
  const cleaned = scrubTelemetryString(value).trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  return SCOPE.test(cleaned) ? cleaned : 'app';
}

function normalizeOperation(value: unknown): string {
  if (typeof value !== 'string') return 'unspecified';
  const cleaned = scrubTelemetryString(value).trim().slice(0, 80);
  return OPERATION.test(cleaned) ? cleaned : 'unspecified';
}

function normalizeCode(value: string): string {
  const cleaned = scrubTelemetryString(value).trim();
  return ERROR_CODE.test(cleaned) ? cleaned : 'UNKNOWN';
}

function normalizeName(value: string): string {
  const cleaned = scrubTelemetryString(value).trim();
  return ERROR_NAME.test(cleaned) ? cleaned : 'Error';
}

function isAbort(name: string, code: string, message: string): boolean {
  if (name === 'AbortError') return true;
  if (code === 'ERR_CANCELED' || code === 'ABORT_ERR') return true;
  return ABORT.test(message);
}

function isAuthLifecycle(name: string, code: string, message: string, status: number | undefined, unauthenticated: boolean): boolean {
  if (name === 'AuthSessionMissingError') return true;
  if (AUTH_MISSING.test(message)) return true;
  if (!unauthenticated) return false;
  return status === 401 || code === '401';
}

function isTransient(name: string, code: string, message: string): boolean {
  if (name === 'AuthRetryableFetchError') return true;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') return true;
  return TRANSIENT.test(message);
}

export function classifyTelemetry(error: unknown, hints: TelemetryHints = {}): ClassifiedTelemetry {
  const scope = normalizeScope(hints.scope);
  const operation = normalizeOperation(hints.operation);
  const message = readMessage(error);
  const rawCode = readCode(error);
  const error_code = normalizeCode(rawCode);
  const error_name = normalizeName(readName(error));
  const http_status = readStatus(error);
  const unauthenticated = hints.unauthenticated === true;

  let action: TelemetryAction = 'capture';
  if (isAbort(error_name, rawCode, message)) action = 'ignore';
  else if (isAuthLifecycle(error_name, rawCode, message, http_status, unauthenticated)) action = 'ignore';
  else if (http_status != null && http_status >= 500) action = 'capture';
  else if (isTransient(error_name, rawCode, message)) action = 'breadcrumb';

  const syntheticMessage = `[${scope}:${operation}] ${error_name} (${error_code})`;
  const classified: ClassifiedTelemetry = {
    action,
    scope,
    operation,
    error_code,
    error_name,
    fingerprint: ['velor-handled', scope, operation, error_code],
    syntheticMessage,
  };
  if (http_status != null) classified.http_status = http_status;
  return classified;
}
