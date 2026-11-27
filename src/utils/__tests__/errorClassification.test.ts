import { logger } from '../logger';
import { resetTelemetryForTests, setTelemetrySinkForTests } from '../sentry';

type Captured = {
  error: Error;
  tags: Record<string, string>;
  fingerprint: string[];
};

type Recorded = {
  breadcrumbs: { category?: string; level?: string; data?: Record<string, unknown> }[];
  captures: Captured[];
};

const tests: { name: string; run: () => void }[] = [];

function it(name: string, run: () => void) {
  tests.push({ name, run });
}

function assertEqual(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right} but received ${left}`);
}

function assertTrue(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, nested) => {
    if (nested instanceof Error) {
      return { name: nested.name, message: nested.message, stack: nested.stack ?? '' };
    }
    return nested;
  }) ?? '';
}

function installSink(options?: { throwOnCapture?: boolean }) {
  const recorded: Recorded = { breadcrumbs: [], captures: [] };
  let frame: { tags: Record<string, string>; fingerprint: string[] } | null = null;
  resetTelemetryForTests();
  setTelemetrySinkForTests({
    addBreadcrumb(breadcrumb) {
      recorded.breadcrumbs.push(breadcrumb);
    },
    withScope(callback) {
      const next = { tags: {} as Record<string, string>, fingerprint: [] as string[] };
      frame = next;
      try {
        callback({
          setTag(key, value) {
            next.tags[key] = value;
          },
          setFingerprint(fingerprint) {
            next.fingerprint = [...fingerprint];
          },
        });
      } finally {
        frame = null;
      }
    },
    captureException(error) {
      recorded.captures.push({
        error,
        tags: { ...(frame?.tags ?? {}) },
        fingerprint: [...(frame?.fingerprint ?? [])],
      });
      if (options?.throwOnCapture) throw new Error('sentry sink failed');
    },
  });
  return recorded;
}

const PII = ['adam@example.com', '12-34-56', '12345678', '£25.15'];

it('ignores abort and missing-session errors with no Sentry traffic', () => {
  const recorded = installSink();
  const aborted = new Error('The operation was aborted');
  aborted.name = 'AbortError';
  const missing = new Error('Auth session missing!');
  missing.name = 'AuthSessionMissingError';
  logger.error('home', { operation: 'fetchHomeFeed.session', error: aborted });
  logger.error('home', { operation: 'fetchHomeFeed.session', error: missing, unauthenticated: true });
  assertEqual(recorded.captures, []);
  assertEqual(recorded.breadcrumbs, []);
});

it('records transient mobile network failures as breadcrumbs only', () => {
  const recorded = installSink();
  const offline = new TypeError('Network request failed');
  const retryable = new Error('The Internet connection appears to be offline');
  retryable.name = 'AuthRetryableFetchError';
  const lost = new TypeError('Failed to fetch');
  logger.error('home', { operation: 'fetchHomeFeed.receipts', error: offline });
  logger.error('home', { operation: 'fetchHomeFeed.receipts', error: retryable });
  logger.error('home', { operation: 'fetchHomeFeed.groups', error: lost });
  assertEqual(recorded.captures, []);
  assertEqual(recorded.breadcrumbs.length, 3);
  assertTrue(recorded.breadcrumbs.every((crumb) => crumb.category === 'network' && crumb.level === 'info'), 'breadcrumb shape drifted');
  assertEqual(recorded.breadcrumbs[0]?.data?.error_name, 'TypeError');
  assertEqual(recorded.breadcrumbs[1]?.data?.error_name, 'AuthRetryableFetchError');
  assertEqual(recorded.breadcrumbs[2]?.data?.error_code, 'UNKNOWN');
});

it('captures a postgres failure with a non-PII fingerprint and tags', () => {
  const recorded = installSink();
  const error = {
    name: 'PostgrestError',
    code: '42501',
    message: 'RLS denied for adam@example.com sort 12-34-56 acc 12345678 £25.15',
  };
  logger.error('home', { operation: 'fetchHomeFeed.receipts', error });
  assertEqual(recorded.breadcrumbs, []);
  assertEqual(recorded.captures.length, 1);
  const captured = recorded.captures[0];
  assertEqual(captured?.tags, {
    scope: 'home',
    operation: 'fetchHomeFeed.receipts',
    error_code: '42501',
  });
  assertEqual(captured?.fingerprint, ['velor-handled', 'home', 'fetchHomeFeed.receipts', '42501']);
  assertEqual(captured?.error.message, '[home:fetchHomeFeed.receipts] PostgrestError (42501)');
  const payload = serialize(recorded);
  for (const secret of PII) {
    assertTrue(!payload.includes(secret), `payload leaked ${secret}`);
  }
});

it('captures the same reportable error once inside the burst window', () => {
  const recorded = installSink();
  const error = { name: 'PostgrestError', code: '23505', message: 'duplicate key' };
  for (let index = 0; index < 5; index += 1) {
    logger.error('home', { operation: 'fetchHomeFeed.receipts', error });
  }
  assertEqual(recorded.captures.length, 1);
  assertEqual(recorded.breadcrumbs.length, 4);
  assertEqual(recorded.captures[0]?.tags.error_code, '23505');
});

it('swallows a synchronous Sentry failure', () => {
  installSink({ throwOnCapture: true });
  let escaped = false;
  try {
    logger.error('home', {
      operation: 'fetchHomeFeed.summary',
      error: { name: 'TypeError', code: '22P02', message: 'malformed response' },
    });
  } catch {
    escaped = true;
  }
  assertTrue(!escaped, 'telemetry threw into the caller');
});

let failed = 0;
for (const test of tests) {
  try {
    test.run();
    process.stdout.write(`ok ${test.name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`not ok ${test.name}\n`);
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : 'unknown test failure'}\n`);
  }
}

resetTelemetryForTests();

if (failed > 0) {
  throw new Error(`${failed} classification test${failed === 1 ? '' : 's'} failed`);
}
