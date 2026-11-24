import type { Breadcrumb, Event } from '@sentry/react-native';

import { scrubSentryBreadcrumb, scrubSentryEvent, scrubString, scrubUnknown } from '../sentry';

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

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
const STACK = 'Failed to save split\n    at saveSplit (src/utils/manualBill.ts:42:8)\n    at RootLayout (src/app/_layout.tsx:31:12)';

it('redacts emails, UK phones, tokens, push tokens, signed URLs, handles, and amounts', () => {
  const input = [
    'Contact ada@example.com or +44 7700 900123 or 07700900123 or 020 7946 0958.',
    `Authorization: Bearer ${JWT}`,
    `push ExponentPushToken[abcDEF_123] and ExpoPushToken[zzzz]`,
    'https://abc.supabase.co/storage/v1/object/sign/receipts/bill.jpg?token=super-secret&apikey=service-key',
    'Pay https://monzo.me/ada-lane or revolut.me/ada.lane and ping @ada.lane',
    'Balance due £42.50 and 18.00 GBP',
  ].join(' ');

  const redacted = scrubString(input);
  assertTrue(!redacted.includes('ada@example.com'), 'email leaked');
  assertTrue(!redacted.includes('7700'), 'phone leaked');
  assertTrue(!redacted.includes('07700900123'), 'mobile leaked');
  assertTrue(!redacted.includes('7946'), 'landline leaked');
  assertTrue(!redacted.includes(JWT), 'jwt leaked');
  assertTrue(!redacted.includes('Bearer'), 'bearer leaked');
  assertTrue(!redacted.includes('ExponentPushToken'), 'push token leaked');
  assertTrue(!redacted.includes('ExpoPushToken'), 'expo push token leaked');
  assertTrue(!redacted.includes('super-secret'), 'storage token leaked');
  assertTrue(!redacted.includes('service-key'), 'apikey leaked');
  assertTrue(!redacted.includes('monzo.me'), 'monzo link leaked');
  assertTrue(!redacted.includes('revolut.me'), 'revolut link leaked');
  assertTrue(!redacted.includes('@ada.lane'), 'handle leaked');
  assertTrue(!redacted.includes('£42.50'), 'amount leaked');
  assertTrue(!redacted.includes('18.00'), 'gbp amount leaked');
  assertTrue(redacted.includes('[REDACTED_EMAIL]'), 'email marker missing');
  assertTrue(redacted.includes('[REDACTED_PHONE]'), 'phone marker missing');
  assertTrue(redacted.includes('[REDACTED_TOKEN]'), 'token marker missing');
  assertTrue(redacted.includes('[REDACTED_PUSH_TOKEN]'), 'push marker missing');
  assertTrue(redacted.includes('token=[REDACTED]'), 'token query marker missing');
  assertTrue(redacted.includes('apikey=[REDACTED]'), 'apikey query marker missing');
  assertTrue(redacted.includes('[REDACTED_HANDLE]'), 'handle marker missing');
  assertTrue(redacted.includes('[REDACTED_AMOUNT]'), 'amount marker missing');
});

it('redacts sensitive keys and strips user profile fields while keeping an opaque id', () => {
  const event: Event = {
    message: 'Failed to save split',
    user: {
      id: 'user_123',
      email: 'ada@example.com',
      username: 'ada',
      ip_address: '203.0.113.4',
      name: 'Ada Lane',
    },
    extra: {
      authorization: `Bearer ${JWT}`,
      payout_handle: 'https://monzo.me/ada',
      email: 'ada@example.com',
      note: 'Split saved',
    },
    request: {
      url: `https://abc.supabase.co/rest/v1/receipts?access_token=${JWT}`,
      headers: {
        Authorization: `Bearer ${JWT}`,
        apikey: 'service-key',
      },
      data: { phone: '07700900123', merchant: 'Tesco' },
    },
    exception: {
      values: [
        {
          type: 'Error',
          value: `Failed to save split for ada@example.com (${JWT})`,
          stacktrace: {
            frames: [
              {
                filename: 'src/utils/manualBill.ts',
                function: 'saveSplit',
                lineno: 42,
                colno: 8,
                context_line: 'throw new Error("ada@example.com")',
                vars: { email: 'ada@example.com', total: '£12.00' },
              },
            ],
          },
        },
      ],
    },
  };

  const scrubbed = scrubSentryEvent(event);
  assertEqual(scrubbed.user, { id: 'user_123' });
  assertEqual(scrubbed.extra, {
    authorization: '[REDACTED]',
    payout_handle: '[REDACTED]',
    email: '[REDACTED]',
    note: 'Split saved',
  });
  assertTrue(!JSON.stringify(scrubbed.request).includes(JWT), 'request jwt leaked');
  assertTrue(!JSON.stringify(scrubbed.request).includes('service-key'), 'request apikey leaked');
  assertTrue(!JSON.stringify(scrubbed.request).includes('07700900123'), 'request phone leaked');
  assertEqual(scrubbed.request?.headers?.Authorization, '[REDACTED]');
  assertEqual(scrubbed.request?.data, { phone: '[REDACTED]', merchant: 'Tesco' });
  assertTrue(scrubbed.request?.url?.includes('access_token=[REDACTED]') === true, 'access token query missing');
  assertEqual(scrubbed.exception?.values?.[0]?.type, 'Error');
  assertTrue(scrubbed.exception?.values?.[0]?.value?.includes('[REDACTED_EMAIL]') === true, 'exception email missing');
  assertTrue(!scrubbed.exception?.values?.[0]?.value?.includes(JWT), 'exception jwt leaked');
  const frame = scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0];
  assertEqual(frame?.filename, 'src/utils/manualBill.ts');
  assertEqual(frame?.function, 'saveSplit');
  assertEqual(frame?.lineno, 42);
  assertEqual(frame?.colno, 8);
  assertTrue(frame?.context_line?.includes('[REDACTED_EMAIL]') === true, 'context line still has email');
  assertTrue(frame?.vars === undefined, 'frame locals leaked');
  assertEqual(scrubbed.message, 'Failed to save split');
});

it('keeps readable error messages and stack frames', () => {
  const event: Event = {
    message: STACK,
    exception: {
      values: [
        {
          type: 'TypeError',
          value: STACK,
          stacktrace: {
            frames: [
              { filename: 'src/utils/manualBill.ts', function: 'saveSplit', lineno: 42, colno: 8 },
              { filename: 'src/app/_layout.tsx', function: 'RootLayout', lineno: 31, colno: 12 },
            ],
          },
        },
      ],
    },
  };

  const scrubbed = scrubSentryEvent(event);
  assertEqual(scrubbed.message, STACK);
  const traced = scrubSentryEvent({
    transaction: 'GET /receipts',
    spans: [{ span_id: 'a', trace_id: 'b', start_timestamp: 1, data: { url: 'https://monzo.me/ada' }, description: 'save ada@example.com' }],
  });
  assertEqual(traced.transaction, 'GET /receipts');
  assertEqual(traced.spans?.[0]?.description, 'save [REDACTED_EMAIL]');
  assertEqual(traced.spans?.[0]?.data?.url, '[REDACTED_HANDLE]');
  assertEqual(scrubbed.exception?.values?.[0]?.value, STACK);
  assertEqual(scrubbed.exception?.values?.[0]?.stacktrace?.frames, [
    { filename: 'src/utils/manualBill.ts', function: 'saveSplit', lineno: 42, colno: 8 },
    { filename: 'src/app/_layout.tsx', function: 'RootLayout', lineno: 31, colno: 12 },
  ]);
});

it('redacts breadcrumb urls and payloads and survives circular data', () => {
  const data: Record<string, unknown> = {
    url: 'https://abc.supabase.co/storage/v1/object/sign/receipts/bill.jpg?token=super-secret',
    email: 'ada@example.com',
    payout_handle: '@ada.lane',
  };
  data.self = data;

  let scrubbed: Breadcrumb | undefined;
  assertTrue(
    (() => {
      scrubbed = scrubSentryBreadcrumb({
        category: 'http',
        message: 'GET https://revolut.me/ada.lane',
        data,
      });
      return true;
    })(),
    'breadcrumb scrub threw',
  );

  assertEqual(scrubbed?.message, 'GET [REDACTED_HANDLE]');
  assertEqual(scrubbed?.data?.email, '[REDACTED]');
  assertEqual(scrubbed?.data?.payout_handle, '[REDACTED]');
  assertEqual(scrubbed?.data?.self, '[Circular]');
  assertTrue(!JSON.stringify(scrubbed?.data?.url).includes('super-secret'), 'breadcrumb token leaked');
  assertTrue(String(scrubbed?.data?.url).includes('token=[REDACTED]'), 'breadcrumb token marker missing');
});

it('stops at max depth without throwing', () => {
  let nested: unknown = { label: 'leaf' };
  for (let i = 0; i < 12; i += 1) nested = { child: nested };
  const scrubbed = scrubUnknown(nested) as { child?: unknown };
  assertTrue(JSON.stringify(scrubbed).includes('[REDACTED]'), 'deep value was not capped');
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

if (failed > 0) {
  throw new Error(`${failed} sentry test${failed === 1 ? '' : 's'} failed`);
}
