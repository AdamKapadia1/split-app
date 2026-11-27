import { logger } from '../../utils/logger';
import {
  fetchHomeFeed,
  shouldCommitHomeFeed,
  type HomeFeedClient,
  type HomeFeedQuery,
} from '../HomeFeedService';

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

function chain(result: { data: unknown; error: unknown }): HomeFeedQuery {
  const query = Promise.resolve(result) as unknown as HomeFeedQuery;
  query.select = () => query;
  query.order = () => query;
  query.limit = () => query;
  query.in = () => query;
  query.eq = () => query;
  query.gt = () => query;
  return query;
}

function silenceLogger() {
  const calls: unknown[][] = [];
  const original = logger.error;
  logger.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore() {
      logger.error = original;
    },
  };
}

it('returns an empty feed when the session is missing or still hydrating', async () => {
  const log = silenceLogger();
  try {
    const blocked: HomeFeedClient = {
      auth: {
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      },
      from: () => {
        throw new Error('query during signed-out boot');
      },
    };
    const missing = new Error('Auth session missing!');
    missing.name = 'AuthSessionMissingError';
    const hydrating: HomeFeedClient = {
      auth: {
        getSession: () => Promise.resolve({ data: { session: null }, error: missing }),
      },
      from: () => {
        throw new Error('query during auth hydration');
      },
    };

    assertEqual(await fetchHomeFeed({ client: null }), []);
    assertEqual(await fetchHomeFeed({ client: blocked }), []);
    assertEqual(await fetchHomeFeed({ client: hydrating }), []);
    assertEqual(log.calls, []);
  } finally {
    log.restore();
  }
});

it('returns a zeroed feed for a new user with empty relations and null fields', async () => {
  const log = silenceLogger();
  try {
    const tables = new Map<string, unknown>([
      ['receipts', null],
      ['groups', null],
      ['receipt_splits', null],
      ['profiles', null],
      ['settlement_nudges', null],
    ]);
    const client: HomeFeedClient = {
      auth: {
        getSession: () => Promise.resolve({ data: { session: { user: { id: 'user-1' } } }, error: null }),
      },
      from: (table) => chain({ data: tables.get(table) ?? null, error: null }),
    };

    assertEqual(await fetchHomeFeed({ client }), []);

    tables.set('receipts', [{
      id: 'receipt-1',
      host_id: 'user-1',
      paid_by: null,
      group_id: null,
      merchant_name: null,
      restaurant_name: null,
      total_amount: null,
      status: null,
      settled_at: null,
      created_at: '2026-01-02T00:00:00.000Z',
    }]);
    tables.set('groups', null);
    const feed = await fetchHomeFeed({ client });
    assertEqual(feed, [{
      id: 'receipt-1',
      hostId: 'user-1',
      paidBy: null,
      creditorName: 'Someone',
      merchantName: null,
      restaurantName: null,
      groupId: null,
      groupName: null,
      totalMinor: 0,
      settled: false,
      createdAt: '2026-01-02T00:00:00.000Z',
      shares: [],
    }]);
    assertEqual(log.calls, []);
  } finally {
    log.restore();
  }
});

it('drops an older home feed result when a newer request is already current', () => {
  let latest = 0;
  let applied: string | null = null;
  const queued: (() => void)[] = [];
  const first = (latest += 1);
  queued.push(() => {
    if (shouldCommitHomeFeed(first, latest, true)) applied = 'stale';
  });
  const second = (latest += 1);
  if (shouldCommitHomeFeed(second, latest, true)) applied = 'fresh';
  for (const job of queued) job();
  assertEqual(applied, 'fresh');
  assertTrue(!shouldCommitHomeFeed(first, latest, true), 'stale generation was accepted');
  assertTrue(!shouldCommitHomeFeed(second, latest, false), 'unmounted generation was accepted');
});

async function runAll() {
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
  if (failed > 0) {
    throw new Error(`${failed} home feed test${failed === 1 ? '' : 's'} failed`);
  }
}

runAll().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : 'home feed tests failed'}\n`);
  process.exit(1);
});
