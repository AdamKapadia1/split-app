import {
  claimHostPaidEmail,
  newClaimTimestamp,
  rollbackHostPaidClaim,
  type ClaimFilter,
  type HostPaidClaimClient,
} from '../hostPaidClaim';

const tests: { name: string; run: () => Promise<void> }[] = [];

function it(name: string, run: () => Promise<void>) {
  tests.push({ name, run });
}

function assertEqual(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right} but received ${left}`);
}

const SHARE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Row = { id: string; host_notified_at: string | null };
type Filter = { op: 'eq' | 'is'; column: string; value: string | null };
type Call = { table: string; values: Record<string, unknown>; filters: Filter[]; selected: string | null };

/** In-memory PostgREST stand-in that applies the filters it is given. */
function fakeClient(rows: Row[], fail = false) {
  const calls: Call[] = [];
  const client: HostPaidClaimClient = {
    from(table) {
      return {
        update(values) {
          const call: Call = { table, values, filters: [], selected: null };
          calls.push(call);
          const execute = () => {
            if (fail) return { data: null, error: { message: 'boom' } };
            const matched = rows.filter((row) => call.filters.every((filter) => (
              (row as Record<string, unknown>)[filter.column] === filter.value
            )));
            for (const row of matched) Object.assign(row, values);
            return { data: matched.map((row) => ({ id: row.id })), error: null };
          };
          const builder: ClaimFilter = {
            eq(column, value) {
              call.filters.push({ op: 'eq', column, value });
              return builder;
            },
            is(column, value) {
              call.filters.push({ op: 'is', column, value });
              return builder;
            },
            select(columns) {
              call.selected = columns;
              return Promise.resolve(execute());
            },
            then(resolve, reject) {
              return Promise.resolve(execute()).then(resolve, reject);
            },
          };
          return builder;
        },
      };
    },
  };
  return { client, calls };
}

it('claims an unnotified share with the exact claimedAt timestamp', async () => {
  const rows: Row[] = [{ id: SHARE, host_notified_at: null }];
  const fake = fakeClient(rows);
  const claimedAt = newClaimTimestamp(new Date('2026-11-28T10:00:00.123Z'));
  assertEqual(await claimHostPaidEmail(fake.client, SHARE, claimedAt), 'claimed');
  assertEqual(rows[0]?.host_notified_at, '2026-11-28T10:00:00.123Z');
  assertEqual(fake.calls[0]?.table, 'receipt_share_participants');
  assertEqual(fake.calls[0]?.filters, [
    { op: 'eq', column: 'id', value: SHARE },
    { op: 'is', column: 'host_notified_at', value: null },
  ]);
});

it('reports already_notified when another request holds the claim', async () => {
  const rows: Row[] = [{ id: SHARE, host_notified_at: '2026-11-28T09:59:59.000Z' }];
  const fake = fakeClient(rows);
  assertEqual(await claimHostPaidEmail(fake.client, SHARE, '2026-11-28T10:00:00.000Z'), 'already_notified');
  assertEqual(rows[0]?.host_notified_at, '2026-11-28T09:59:59.000Z');
});

it('scopes rollback to id AND the exact claimedAt', async () => {
  const rows: Row[] = [{ id: SHARE, host_notified_at: '2026-11-28T10:00:00.000Z' }];
  const fake = fakeClient(rows);
  assertEqual(await rollbackHostPaidClaim(fake.client, SHARE, '2026-11-28T10:00:00.000Z'), true);
  assertEqual(fake.calls[0]?.values, { host_notified_at: null });
  assertEqual(fake.calls[0]?.filters, [
    { op: 'eq', column: 'id', value: SHARE },
    { op: 'eq', column: 'host_notified_at', value: '2026-11-28T10:00:00.000Z' },
  ]);
  assertEqual(rows[0]?.host_notified_at, null);
});

it("a failed request's rollback cannot wipe a concurrent successful marker", async () => {
  const rows: Row[] = [{ id: SHARE, host_notified_at: null }];
  const fake = fakeClient(rows);
  const failedAt = '2026-11-28T10:00:00.000Z';
  const winnerAt = '2026-11-28T10:00:01.000Z';
  assertEqual(await claimHostPaidEmail(fake.client, SHARE, failedAt), 'claimed');
  // Simulates the window where the marker was cleared and a second request
  // claimed and delivered before the first request's rollback ran.
  rows[0]!.host_notified_at = winnerAt;
  await rollbackHostPaidClaim(fake.client, SHARE, failedAt);
  assertEqual(rows[0]?.host_notified_at, winnerAt);
});

it('reports errors instead of throwing', async () => {
  const fake = fakeClient([{ id: SHARE, host_notified_at: null }], true);
  assertEqual(await claimHostPaidEmail(fake.client, SHARE, newClaimTimestamp()), 'error');
  assertEqual(await rollbackHostPaidClaim(fake.client, SHARE, newClaimTimestamp()), false);
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
  if (failed > 0) throw new Error(`${failed} host paid claim test${failed === 1 ? '' : 's'} failed`);
}

void run();
