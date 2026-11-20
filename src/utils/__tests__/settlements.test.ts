import {
  calculateNetBalances,
  simplifyDebts,
  type SettlementRecordInput,
  type SettlementSplitInput,
} from '../settlements';

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

const members = ['alex', 'sam', 'jordan'];

it('settles a two-person split in full back to zero', () => {
  const balances = calculateNetBalances(
    [{ id: 'receipt-1', paid_by: 'sam' }],
    [{ receipt_id: 'receipt-1', user_id: 'alex', amount_minor: 2450 }],
    [settlement('alex', 'sam', 2450)],
    ['alex', 'sam'],
  );

  assertEqual(balances, { alex: 0, sam: 0 });
  assertEqual(simplifyDebts(balances), []);
});

it('collapses a three-person chain into one transfer', () => {
  const balances = calculateNetBalances(
    [
      { id: 'receipt-a', paid_by: 'alex' },
      { id: 'receipt-b', paid_by: 'sam' },
    ],
    [
      { receipt_id: 'receipt-a', user_id: 'sam', amount_minor: 1800 },
      { receipt_id: 'receipt-b', user_id: 'jordan', amount_minor: 1800 },
    ],
    [],
    members,
  );

  assertEqual(balances, { alex: 1800, sam: 0, jordan: -1800 });
  assertEqual(simplifyDebts(balances), [{ fromUserId: 'jordan', toUserId: 'alex', amountMinor: 1800 }]);
});

it('reduces the remaining transfer by the exact pence already paid', () => {
  const balances = calculateNetBalances(
    [{ id: 'receipt-1', paid_by: 'sam' }],
    [{ receipt_id: 'receipt-1', user_id: 'alex', amount_minor: 1248 }],
    [settlement('alex', 'sam', 400)],
    ['alex', 'sam'],
  );

  assertEqual(balances, { alex: -848, sam: 848 });
  assertEqual(simplifyDebts(balances), [{ fromUserId: 'alex', toUserId: 'sam', amountMinor: 848 }]);
});

it('ignores a voided settlement', () => {
  const splits: SettlementSplitInput[] = [{ receipt_id: 'receipt-1', user_id: 'alex', amount_minor: 1840 }];
  const voided: SettlementRecordInput = {
    ...settlement('alex', 'sam', 1840),
    voided_at: '2026-11-20T12:00:00.000Z',
  };

  const balances = calculateNetBalances([{ id: 'receipt-1', paid_by: 'sam' }], splits, [voided], ['alex', 'sam']);

  assertEqual(balances, { alex: -1840, sam: 1840 });
  assertEqual(simplifyDebts(balances), [{ fromUserId: 'alex', toUserId: 'sam', amountMinor: 1840 }]);
});

it('stays zero-sum across receipts and odd penny shares', () => {
  const balances = calculateNetBalances(
    [
      { id: 'receipt-1', paid_by: 'alex' },
      { id: 'receipt-2', paid_by: 'sam' },
      { id: 'unpaid', paid_by: null },
    ],
    [
      { receipt_id: 'receipt-1', user_id: 'alex', amount_minor: 34 },
      { receipt_id: 'receipt-1', user_id: 'sam', amount_minor: 33 },
      { receipt_id: 'receipt-1', user_id: 'jordan', amount_minor: 33 },
      { receipt_id: 'receipt-2', user_id: 'alex', amount_minor: 2 },
      { receipt_id: 'receipt-2', user_id: 'sam', amount_minor: 2 },
      { receipt_id: 'receipt-2', user_id: 'jordan', amount_minor: 1 },
      { receipt_id: 'unpaid', user_id: 'alex', amount_minor: 99 },
      { receipt_id: 'receipt-1', user_id: 'sam', amount_minor: 0 },
    ],
    [],
    members,
  );

  const sum = Object.values(balances).reduce((total, amount) => total + amount, 0);
  assertEqual(sum, 0);
  assertEqual(balances, { alex: 64, sam: -30, jordan: -34 });
  for (const amount of Object.values(balances)) assertTrue(Number.isInteger(amount), 'balance must stay in whole pence');

  const transfers = simplifyDebts(balances);
  assertEqual(transfers, [
    { fromUserId: 'jordan', toUserId: 'alex', amountMinor: 34 },
    { fromUserId: 'sam', toUserId: 'alex', amountMinor: 30 },
  ]);
  assertEqual(
    transfers.reduce((total, transfer) => total + transfer.amountMinor, 0),
    64,
  );
});

function settlement(fromUserId: string, toUserId: string, amountMinor: number): SettlementRecordInput {
  return {
    from_user_id: fromUserId,
    to_user_id: toUserId,
    amount_minor: amountMinor,
    voided_at: null,
  };
}

let failed = 0;
for (const test of tests) {
  try {
    test.run();
    console.log(`ok ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok ${test.name}`);
    console.error(error);
  }
}

if (failed > 0) {
  throw new Error(`${failed} settlement test${failed === 1 ? '' : 's'} failed`);
}
