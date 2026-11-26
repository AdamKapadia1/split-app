import type { Breadcrumb, ErrorEvent, Event, StackFrame, User } from '@sentry/react-native';

const MAX_DEPTH = 8;
const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'apikey',
  'cookie',
  'set-cookie',
  'x-supabase-auth',
  'password',
  'email',
  'phone',
  'payout_handle',
  'monzo_handle',
  'revolut_handle',
  'receipt_url',
  'signed_url',
]);

type SentrySdk = typeof import('@sentry/react-native');

let started = false;
let active = false;
let sentrySdk: SentrySdk | null | undefined;

function loadSentry(): SentrySdk | null {
  if (sentrySdk !== undefined) return sentrySdk;
  try {
    // Optional native module. A static import would crash when the package is absent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sentrySdk = require('@sentry/react-native') as SentrySdk;
  } catch {
    sentrySdk = null;
  }
  return sentrySdk;
}

function readDsn() {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  return typeof dsn === 'string' ? dsn.trim() : '';
}

export function scrubString(value: string) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[REDACTED_TOKEN]')
    .replace(/(ExponentPushToken|ExpoPushToken)\[[^\]]*\]/g, '[REDACTED_PUSH_TOKEN]')
    .replace(/(?:https?:\/\/)?(?:www\.)?monzo\.me\/\S+/gi, '[REDACTED_HANDLE]')
    .replace(/(?:https?:\/\/)?(?:www\.)?revolut\.me\/\S+/gi, '[REDACTED_HANDLE]')
    .replace(/(token|apikey|access_token)=([^&#\s]+)/gi, '$1=[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/(?:\+44|0044)(?:[\s().-]*\d){10,12}\b/g, '[REDACTED_PHONE]')
    .replace(/\b0(?:7(?:[\s-]*\d){9}|[12](?:[\s-]*\d){8,10})\b/g, '[REDACTED_PHONE]')
    .replace(/@[A-Za-z0-9._-]{3,}/g, '[REDACTED_HANDLE]')
    .replace(/£\s?\d[\d,]*(?:\.\d{1,2})?/g, '[REDACTED_AMOUNT]')
    .replace(/\b(?:GBP\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{2})\s?GBP)\b/gi, '[REDACTED_AMOUNT]')
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[REDACTED_IMAGE]');
}

function isSensitiveKey(key: string) {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

export function scrubUnknown(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (depth >= MAX_DEPTH) return REDACTED;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (typeof value === 'bigint') return scrubString(value.toString());
  if (typeof value !== 'object') return REDACTED;

  const objects = seen ?? new WeakSet<object>();
  if (objects.has(value)) return CIRCULAR;
  objects.add(value);

  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => scrubUnknown(item, depth + 1, objects));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : scrubUnknown(nested, depth + 1, objects);
  }
  return output;
}

function scrubFrame(frame: StackFrame): StackFrame {
  const next: StackFrame = { ...frame };
  delete next.vars;
  if (next.context_line) next.context_line = scrubString(next.context_line);
  if (next.pre_context) next.pre_context = next.pre_context.map((line) => scrubString(line));
  if (next.post_context) next.post_context = next.post_context.map((line) => scrubString(line));
  if (next.filename) next.filename = scrubString(next.filename);
  if (next.abs_path) next.abs_path = scrubString(next.abs_path);
  return next;
}

function scrubUser(user: User | undefined) {
  if (!user || user.id == null || user.id === '') return undefined;
  if (typeof user.id === 'string') return { id: scrubString(user.id) };
  return { id: user.id };
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  if (event.message) event.message = scrubString(event.message);
  if (event.logentry?.message) event.logentry.message = scrubString(event.logentry.message);
  if (event.transaction) event.transaction = scrubString(event.transaction);
  for (const span of event.spans ?? []) {
    if (span.description) span.description = scrubString(span.description);
    if (span.data) span.data = scrubUnknown(span.data) as typeof span.data;
  }

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubString(exception.value);
    if (exception.stacktrace?.frames) {
      exception.stacktrace.frames = exception.stacktrace.frames.map((frame) => scrubFrame(frame));
    }
  }

  if (event.extra) event.extra = scrubUnknown(event.extra) as T['extra'];
  if (event.contexts) event.contexts = scrubUnknown(event.contexts) as T['contexts'];
  if (event.tags) event.tags = scrubUnknown(event.tags) as T['tags'];
  if (event.request) {
    if (event.request.url) event.request.url = scrubString(event.request.url);
    if (event.request.headers) {
      event.request.headers = scrubUnknown(event.request.headers) as Record<string, string>;
    }
    if ('data' in event.request) event.request.data = scrubUnknown(event.request.data);
    if (typeof event.request.query_string === 'string') {
      event.request.query_string = scrubString(event.request.query_string);
    } else if (event.request.query_string) {
      event.request.query_string = scrubUnknown(event.request.query_string) as Event['request'] extends { query_string?: infer Query }
        ? Query
        : never;
    }
    if (event.request.cookies) {
      event.request.cookies = scrubUnknown(event.request.cookies) as Record<string, string>;
    }
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((breadcrumb) => scrubSentryBreadcrumb(breadcrumb));
  }

  const user = scrubUser(event.user);
  if (user) event.user = user;
  else delete event.user;

  return event;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const next: Breadcrumb = { ...breadcrumb };
  if (next.message) next.message = scrubString(next.message);
  if (next.category) next.category = scrubString(next.category);
  if (next.data) {
    const data = scrubUnknown(next.data);
    next.data = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : { value: data };
  }
  return next;
}

export function initSentry() {
  if (started) return;

  const Sentry = loadSentry();
  if (!Sentry) return;

  // Bind a client even when the DSN is absent or reporting is off. Sentry.wrap
  // finishes the App Start span from the root mount, and that fails closed if
  // init has not run yet.
  const dsn = readDsn();
  started = true;
  try {
  Sentry.init({
    dsn: dsn || undefined,
    enabled: !__DEV__ && Boolean(dsn),
    environment: __DEV__ ? 'development' : (process.env.EXPO_PUBLIC_APP_ENV ?? 'production'),
    sendDefaultPii: false,
    enableAutoSessionTracking: true,
    tracesSampleRate: 0.2,
    attachScreenshot: false,
    attachViewHierarchy: false,
    beforeSend(event) {
      try {
        return scrubSentryEvent(event);
      } catch {
        return null;
      }
    },
    beforeBreadcrumb(breadcrumb) {
      try {
        return scrubSentryBreadcrumb(breadcrumb);
      } catch {
        return null;
      }
    },
  });
  active = !__DEV__ && Boolean(dsn);
  } catch (error) {
    active = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { logger } = require('./logger') as typeof import('./logger');
      logger.error('sentry', { code: 'INIT_FAILED', error });
    } catch {
      // Crash reporting must never take down startup.
    }
  }
}

export function setSentryUser(userId: string | null) {
  try {
    if (!active) return;
    const Sentry = loadSentry();
    if (!Sentry) return;
    Sentry.setUser(userId ? { id: scrubString(userId) } : null);
  } catch {
    // Identifying a user must never crash the session.
  }
}

export function captureSanitizedException(error: unknown, context?: Record<string, unknown>) {
  try {
    if (__DEV__ || !active) return;
    const Sentry = loadSentry();
    if (!Sentry) return;

    const safeContext = context ? scrubUnknown(context) : undefined;
    Sentry.withScope((scope) => {
      if (safeContext && typeof safeContext === 'object' && !Array.isArray(safeContext)) {
        scope.setContext('handled', safeContext as Record<string, unknown>);
      }
      if (error instanceof Error) {
        const safe = new Error(scrubString(error.message));
        safe.name = error.name || 'Error';
        if (error.stack) safe.stack = scrubString(error.stack);
        Sentry.captureException(safe);
        return;
      }
      const message = typeof error === 'string' ? scrubString(error) : 'Handled application error';
      Sentry.captureException(new Error(message));
    });
  } catch {
    // Sentry must never take down the error boundary.
  }
}

export type { ErrorEvent };
