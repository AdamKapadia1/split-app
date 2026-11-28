import { logger } from '../../utils/logger';
import {
  asShareError,
  BillShareServiceError,
  isTransientReadFailure,
  parseHostClaimState,
  parseSharedBill,
  READ_RETRY_DELAY_MS,
  runReadRpc,
  type ReadRpcResponse,
} from '../billShareCore';

// Silence the real logger sink; individual tests install their own spy.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

const tests: { name: string; run: () => Promise<void> | void }[] = [];

function it(name: string, run: () => Promise<void> | void) {
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

const RECEIPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const HOST_CLAIMS = {
  host_display_name: 'Sam',
  claimed_item_ids: [ITEM],
  amount_owed_pence: 1250,
  unclaimed_pence: 0,
  items_claimed: 1,
  items_total: 1,
  host_confirmed_at: null,
};

const SHARED_BILL = {
  bill: { id: RECEIPT, merchant_name: 'Cafe', total_pence: 1250 },
  owner: { host_display_name: 'Sam', payout_details: null },
  items: [],
  participants: [],
};

/** Exactly what supabase-js returns when the request never completed. */
const NETWORK_DROP: ReadRpcResponse = {
  data: null,
  error: { message: 'TypeError: Network request failed', details: '', hint: '', code: '' },
  status: 0,
};
/** A gateway HTML page: no JSON, so no code. */
const GATEWAY_502: ReadRpcResponse = { data: null, error: { message: '<html>502 Bad Gateway</html>' }, status: 502 };
const RLS_DENIED: ReadRpcResponse = {
  data: null,
  error: { code: '42501', message: 'Not authorised', details: null, hint: null },
  status: 403,
};
const INVALID_TOKEN: ReadRpcResponse = {
  data: null,
  error: { code: '22023', message: 'invalid share token', details: null, hint: null },
  status: 400,
};

function ok(data: unknown): ReadRpcResponse {
  return { data, error: null, status: 200 };
}

/** Replays scripted responses and counts calls. */
function scripted(...responses: ReadRpcResponse[]) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    call: () => {
      const response = responses[Math.min(calls, responses.length - 1)]!;
      calls += 1;
      return Promise.resolve(response);
    },
  };
}

function sleeper() {
  const waits: number[] = [];
  return { waits, sleep: (ms: number) => { waits.push(ms); return Promise.resolve(); } };
}

function spyLogger() {
  const original = logger.error;
  const calls: unknown[][] = [];
  logger.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return { calls, restore: () => { logger.error = original; } };
}

async function expectThrow(run: () => Promise<unknown>): Promise<BillShareServiceError> {
  try {
    await run();
  } catch (error) {
    assertTrue(error instanceof BillShareServiceError, 'expected a BillShareServiceError');
    return error as BillShareServiceError;
  }
  throw new Error('expected the call to throw');
}

const readers = [
  { name: 'fetchHostClaims', parse: parseHostClaimState, good: HOST_CLAIMS, fallback: 'Could not load your items.' },
  { name: 'fetchSharedBill', parse: parseSharedBill, good: SHARED_BILL, fallback: 'Could not load this split.' },
] as const;

for (const reader of readers) {
  it(`${reader.name}: a dropped first attempt retries once after ${READ_RETRY_DELAY_MS}ms and logs nothing`, async () => {
    const log = spyLogger();
    try {
      const rpc = scripted(NETWORK_DROP, ok(reader.good));
      const timer = sleeper();
      const result = await runReadRpc(rpc.call, reader.parse as (data: unknown) => unknown, reader.fallback, timer.sleep);
      assertTrue(result !== null, 'recovered on the second attempt');
      assertEqual(rpc.calls, 2);
      assertEqual(timer.waits, [READ_RETRY_DELAY_MS]);
      assertEqual(log.calls.length, 0);
    } finally {
      log.restore();
    }
  });

  it(`${reader.name}: two drops log once and throw FAILED`, async () => {
    const log = spyLogger();
    try {
      const rpc = scripted(NETWORK_DROP, GATEWAY_502);
      const timer = sleeper();
      const error = await expectThrow(() => runReadRpc(rpc.call, reader.parse as (data: unknown) => unknown, reader.fallback, timer.sleep));
      assertEqual(error.code, 'FAILED');
      assertEqual(rpc.calls, 2);
      assertEqual(log.calls.length, 1);
      assertEqual(log.calls[0], ['BillShareService', { code: 'FAILED' }]);
    } finally {
      log.restore();
    }
  });

  it(`${reader.name}: 42501 fails immediately as UNAUTHORIZED, no retry`, async () => {
    const log = spyLogger();
    try {
      const rpc = scripted(RLS_DENIED, ok(reader.good));
      const timer = sleeper();
      const error = await expectThrow(() => runReadRpc(rpc.call, reader.parse as (data: unknown) => unknown, reader.fallback, timer.sleep));
      assertEqual(error.code, 'UNAUTHORIZED');
      assertEqual(rpc.calls, 1);
      assertEqual(timer.waits, []);
      assertEqual(log.calls[0], ['BillShareService', { code: '42501' }]);
    } finally {
      log.restore();
    }
  });

  it(`${reader.name}: 22023 fails immediately as INVALID, no retry`, async () => {
    const log = spyLogger();
    try {
      const rpc = scripted(INVALID_TOKEN, ok(reader.good));
      const timer = sleeper();
      const error = await expectThrow(() => runReadRpc(rpc.call, reader.parse as (data: unknown) => unknown, reader.fallback, timer.sleep));
      assertEqual(error.code, 'INVALID');
      assertEqual(rpc.calls, 1);
      assertEqual(timer.waits, []);
    } finally {
      log.restore();
    }
  });

  it(`${reader.name}: a malformed 200 response is a parser failure and never retries`, async () => {
    const log = spyLogger();
    try {
      const rpc = scripted(ok([]), ok(reader.good));
      const timer = sleeper();
      const error = await expectThrow(() => runReadRpc(rpc.call, reader.parse as (data: unknown) => unknown, reader.fallback, timer.sleep));
      assertEqual(error.code, 'FAILED');
      assertEqual(error.message, reader.fallback);
      assertEqual(rpc.calls, 1);
      assertEqual(timer.waits, []);
    } finally {
      log.restore();
    }
  });

  it(`${reader.name}: a 4xx with no code is not retried`, async () => {
    const log = spyLogger();
    try {
      const rpc = scripted({ data: null, error: { message: 'Not Found' }, status: 404 }, ok(reader.good));
      const timer = sleeper();
      await expectThrow(() => runReadRpc(rpc.call, reader.parse as (data: unknown) => unknown, reader.fallback, timer.sleep));
      assertEqual(rpc.calls, 1);
    } finally {
      log.restore();
    }
  });

  it(`${reader.name}: null data is "no such bill", not an error`, async () => {
    const rpc = scripted(ok(null));
    assertEqual(await runReadRpc(rpc.call, reader.parse as (data: unknown) => unknown, reader.fallback, sleeper().sleep), null);
    assertEqual(rpc.calls, 1);
  });
}

it('a thrown client error (not configured) is not retried', async () => {
  let calls = 0;
  const error = await expectThrow(() => runReadRpc(() => {
    calls += 1;
    throw new BillShareServiceError('NOT_CONFIGURED', 'Supabase is not configured.');
  }, parseHostClaimState, 'Could not load your items.', sleeper().sleep));
  assertEqual(error.code, 'NOT_CONFIGURED');
  assertEqual(calls, 1);
});

it('isTransientReadFailure only accepts code-less, non-4xx drops', () => {
  assertEqual(isTransientReadFailure(NETWORK_DROP.error, 0), true);
  assertEqual(isTransientReadFailure(GATEWAY_502.error, 503), true);
  assertEqual(isTransientReadFailure(new TypeError('Network request failed')), true);
  assertEqual(isTransientReadFailure({ code: '42501' }, 403), false);
  assertEqual(isTransientReadFailure({ code: '28000' }, 401), false);
  assertEqual(isTransientReadFailure({ code: 'PGRST301' }, 401), false);
  assertEqual(isTransientReadFailure({ code: '22023' }, 400), false);
  assertEqual(isTransientReadFailure({ code: '57014' }, 500), false);
  assertEqual(isTransientReadFailure({ message: 'Too Many Requests' }, 429), false);
  assertEqual(isTransientReadFailure({ message: 'x', status: 401 }), false);
  assertEqual(isTransientReadFailure(new BillShareServiceError('FAILED', 'x')), false);
});

it('asShareError maps 22023 to INVALID and logs only the code', () => {
  const log = spyLogger();
  try {
    const mapped = asShareError(
      { code: '22023', message: 'invalid share token for ada@example.com', details: 'token abc', hint: '£12.50' },
      'FAILED',
      'Could not load this split.',
    );
    assertEqual(mapped.code, 'INVALID');
    assertEqual(log.calls, [['BillShareService', { code: '22023' }]]);
    const logged = JSON.stringify(log.calls);
    assertTrue(!logged.includes('ada@example.com') && !logged.includes('£') && !logged.includes('token abc'), 'PII reached the log');
  } finally {
    log.restore();
  }
});

it('asShareError now logs real SQLSTATEs instead of a blank code', () => {
  const log = spyLogger();
  try {
    const mapped = asShareError({ code: '57014', message: 'canceling statement due to statement timeout' }, 'FAILED', 'Could not load your items.');
    assertEqual(mapped.code, 'FAILED');
    assertEqual(log.calls, [['BillShareService', { code: '57014' }]]);
  } finally {
    log.restore();
  }
});

async function run() {
  let failed = 0;
  for (const test of tests) {
    try {
      await test.run();
      process.stdout.write(`ok ${test.name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`not ok ${test.name}\n`);
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : 'unknown test failure'}\n`);
    }
  }
  if (failed > 0) throw new Error(`${failed} bill share core test${failed === 1 ? '' : 's'} failed`);
}

void run();
