import {
  computeGroupNetBalance,
  computeHomeBalances,
  formatPenceParts,
  HOME_ATTENTION_LIMIT,
  type HomeBalanceReceipt,
} from '../homeBalances';

const tests: { name: string; run: () => void }[] = [];

function it(name: string, run: () => void) {
  tests.push({ name, run });
}

function assertEqual(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`expected ${right} but received ${left}`);
  }
}

function assertTrue(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function receipt(overrides: Partial<HomeBalanceReceipt> & Pick<HomeBalanceReceipt, 'id'>): HomeBalanceReceipt {
  return {
    hostId: 'ada',
    paidBy: 'ada',
    creditorName: 'Ada Kapadia',
    merchantName: 'Nando\'s',
    createdAt: '2026-11-01T12:00:00.000Z',
    settled: false,
    shares: [],
    ...overrides,
  };
}

it('reports a positive net as owed', () => {
  const balances = computeHomeBalances([
    receipt({
      id: 'r1',
      shares: [
        { userId: 'ben', displayName: 'Ben', amountPence: 4200 },
        { userId: 'ada', displayName: 'Ada', amountPence: 4200 },
      ],
    }),
  ], 'ada');

  assertEqual(balances.owedToYouPence, 4200);
  assertEqual(balances.youOwePence, 0);
  assertEqual(balances.netPence, 4200);
  assertEqual(balances.status, 'owed');
  assertEqual(balances.needsAttention.length, 1);
  assertEqual(balances.needsAttention[0]?.type, 'nudge');
  assertEqual(balances.needsAttention[0]?.amountPence, 4200);
});

it('reports a negative net as owes', () => {
  const balances = computeHomeBalances([
    receipt({
      id: 'r1',
      hostId: 'ben',
      paidBy: 'ben',
      creditorName: 'Ben',
      shares: [{ userId: 'ada', displayName: 'Ada', amountPence: 850 }],
    }),
  ], 'ada');

  assertEqual(balances.owedToYouPence, 0);
  assertEqual(balances.youOwePence, 850);
  assertEqual(balances.netPence, -850);
  assertEqual(balances.status, 'owes');
  assertEqual(balances.needsAttention[0]?.type, 'pay');
  assertEqual(balances.needsAttention[0]?.counterpartyName, 'Ben');
});

it('reports an exact zero net as settled', () => {
  const balances = computeHomeBalances([
    receipt({
      id: 'r1',
      shares: [{ userId: 'ben', displayName: 'Ben', amountPence: 500 }],
    }),
    receipt({
      id: 'r2',
      hostId: 'ben',
      paidBy: 'ben',
      creditorName: 'Ben',
      shares: [{ userId: 'ada', displayName: 'Ada', amountPence: 500 }],
    }),
  ], 'ada');

  assertEqual(balances.owedToYouPence, 500);
  assertEqual(balances.youOwePence, 500);
  assertEqual(balances.netPence, 0);
  assertEqual(balances.status, 'settled');
  assertEqual(balances.needsAttention.length, 2);
});

it('excludes settled receipts and settled shares from totals and attention', () => {
  const balances = computeHomeBalances([
    receipt({
      id: 'open',
      createdAt: '2026-11-02T12:00:00.000Z',
      shares: [
        { userId: 'ben', displayName: 'Ben', amountPence: 1000 },
        { userId: 'cam', displayName: 'Cam', amountPence: 250, settled: true },
      ],
    }),
    receipt({
      id: 'archived',
      settled: true,
      shares: [{ userId: 'ben', displayName: 'Ben', amountPence: 9999 }],
    }),
    receipt({
      id: 'float',
      shares: [{ userId: 'ben', displayName: 'Ben', amountPence: 10.5 }],
    }),
  ], 'ada');

  assertEqual(balances.owedToYouPence, 1000);
  assertEqual(balances.youOwePence, 0);
  assertEqual(balances.needsAttention.map((item) => item.receiptId), ['open']);
  assertEqual(balances.needsAttention[0]?.amountPence, 1000);
});

it('uses the payer as creditor and ignores a person\'s own share', () => {
  const balances = computeHomeBalances([
    receipt({
      id: 'r1',
      hostId: 'ada',
      paidBy: 'ben',
      creditorName: 'Ben',
      shares: [
        { userId: 'ada', displayName: 'Ada', amountPence: 700 },
        { userId: 'ben', displayName: 'Ben', amountPence: 700 },
      ],
    }),
  ], 'ada');

  assertEqual(balances.youOwePence, 700);
  assertEqual(balances.owedToYouPence, 0);
  assertEqual(balances.status, 'owes');
});

it('formats integer pence without rounding through floats', () => {
  assertEqual(formatPenceParts(0), { sign: '', pounds: '0', pence: '.00' });
  assertEqual(formatPenceParts(5), { sign: '', pounds: '0', pence: '.05' });
  assertEqual(formatPenceParts(1250), { sign: '', pounds: '12', pence: '.50' });
  assertEqual(formatPenceParts(100000), { sign: '', pounds: '1,000', pence: '.00' });
  assertEqual(formatPenceParts(-1250), { sign: '-', pounds: '12', pence: '.50' });
  assertEqual(`${formatPenceParts(0).pounds}${formatPenceParts(0).pence}`, '0.00');
  assertEqual(`${formatPenceParts(5).pounds}${formatPenceParts(5).pence}`, '0.05');
  assertEqual(`${formatPenceParts(1250).pounds}${formatPenceParts(1250).pence}`, '12.50');
  assertEqual(`${formatPenceParts(100000).pounds}${formatPenceParts(100000).pence}`, '1,000.00');
  assertEqual(formatPenceParts(10.5), { sign: '', pounds: '0', pence: '.00' });
});

it('caps needs attention at five and orders oldest first, then highest amount', () => {
  const receipts = [1, 2, 3, 4, 5, 6].map((day) => receipt({
    id: `r${day}`,
    createdAt: `2026-11-0${day}T12:00:00.000Z`,
    shares: [{ userId: 'ben', displayName: 'Ben', amountPence: day * 100 }],
  }));
  const capped = computeHomeBalances(receipts, 'ada');
  assertEqual(capped.needsAttention.length, HOME_ATTENTION_LIMIT);
  assertEqual(capped.needsAttention.map((item) => item.receiptId), ['r1', 'r2', 'r3', 'r4', 'r5']);
  assertTrue(!capped.needsAttention.some((item) => item.receiptId === 'r6'), 'newest item stayed outside the cap');

  const tied = computeHomeBalances([
    receipt({
      id: 'low',
      createdAt: '2026-11-10T12:00:00.000Z',
      shares: [{ userId: 'ben', displayName: 'Ben', amountPence: 100 }],
    }),
    receipt({
      id: 'high',
      createdAt: '2026-11-10T12:00:00.000Z',
      shares: [{ userId: 'cam', displayName: 'Cam', amountPence: 900 }],
    }),
  ], 'ada');
  assertEqual(tied.needsAttention.map((item) => item.receiptId), ['high', 'low']);
});

it('keeps a cooldown flag on the merged attention row', () => {
  const balances = computeHomeBalances([
    receipt({
      id: 'r1',
      shares: [{ userId: 'ben', displayName: 'Ben', amountPence: 400, isOnCooldown: true }],
    }),
  ], 'ada');
  assertEqual(balances.needsAttention[0]?.isOnCooldown, true);
  assertEqual(balances.needsAttention[0]?.counterpartyName, 'Ben');
});

it('sums a group standing from the same unsettled shares', () => {
  const standing = computeGroupNetBalance([
    receipt({
      id: 'r1',
      shares: [{ userId: 'ben', displayName: 'Ben', amountPence: 1420 }],
    }),
    receipt({
      id: 'r2',
      settled: true,
      shares: [{ userId: 'ben', displayName: 'Ben', amountPence: 5000 }],
    }),
  ], 'ada');

  assertEqual(standing, {
    owedToYouPence: 1420,
    youOwePence: 0,
    netPence: 1420,
    status: 'owed',
  });
});

it('returns a settled standing when nobody is signed in', () => {
  const standing = computeGroupNetBalance([
    receipt({
      id: 'r1',
      shares: [{ userId: 'ben', displayName: 'Ben', amountPence: 100 }],
    }),
  ], null);
  assertEqual(standing.netPence, 0);
  assertEqual(standing.status, 'settled');
  assertEqual(computeHomeBalances([], 'ada').needsAttention, []);
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
  throw new Error(`${failed} home balance test${failed === 1 ? '' : 's'} failed`);
}
