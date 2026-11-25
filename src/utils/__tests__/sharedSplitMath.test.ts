import {
  allocateLargestRemainder,
  reconcileSharedBill,
  splitEquallyDeterministic,
} from '../sharedSplitMath';

const tests: { name: string; run: () => void }[] = [];

function it(name: string, run: () => void) {
  tests.push({ name, run });
}

function assertEqual(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right} but received ${left}`);
}

it('hands remainder pennies to the earliest participant id', () => {
  assertEqual(splitEquallyDeterministic(100, ['c', 'a', 'b']), { a: 34, b: 33, c: 33 });
});

it('keeps a shared item, service, and unclaimed pence on the printed total', () => {
  const result = reconcileSharedBill({
    items: [
      { id: 'latte', pricePence: 380 },
      { id: 'cake', pricePence: 450 },
    ],
    claims: [
      { itemId: 'latte', participantId: 'a' },
      { itemId: 'latte', participantId: 'b' },
    ],
    participantIds: ['a', 'b'],
    totalPence: 910,
    serviceChargePence: 80,
  });

  assertEqual(result.itemsSubtotal, { a: 190, b: 190 });
  assertEqual(result.serviceCharge.a + result.serviceCharge.b, 80);
  assertEqual(result.amountOwed.a + result.amountOwed.b + result.unclaimedPence, 910);
  assertEqual(result.unclaimedPence, 450);
});

it('does not invent a service share before anyone claims', () => {
  const result = reconcileSharedBill({
    items: [{ id: 'latte', pricePence: 500 }],
    claims: [],
    participantIds: ['a', 'b'],
    totalPence: 550,
    serviceChargePence: 50,
  });
  assertEqual(result.amountOwed, { a: 0, b: 0 });
  assertEqual(result.serviceCharge, { a: 0, b: 0 });
  assertEqual(result.unclaimedPence, 550);
});

it('does not give a zero-weight person the service pennies', () => {
  assertEqual(allocateLargestRemainder(10, { a: 100, b: 0 }), { a: 10, b: 0 });
});

it('splits an odd number of pence one penny at a time in participant id order', () => {
  assertEqual(splitEquallyDeterministic(1, ['b', 'a']), { a: 1, b: 0 });
  assertEqual(splitEquallyDeterministic(5, ['c', 'a', 'b']), { a: 2, b: 2, c: 1 });
});

it('gives leftover service pennies to the largest fractional remainder', () => {
  assertEqual(allocateLargestRemainder(10, { b: 200, a: 100 }), { a: 3, b: 7 });
  assertEqual(allocateLargestRemainder(1, { b: 1, a: 1 }), { a: 1, b: 0 });
});

it('keeps proportional service inside the printed total and does not add VAT again', () => {
  const result = reconcileSharedBill({
    items: [
      { id: 'starter', pricePence: 100 },
      { id: 'main', pricePence: 200 },
    ],
    claims: [
      { itemId: 'starter', participantId: 'p1' },
      { itemId: 'main', participantId: 'p2' },
    ],
    participantIds: ['p2', 'p1'],
    totalPence: 330,
    serviceChargePence: 30,
  });

  assertEqual(result.itemsSubtotal, { p1: 100, p2: 200 });
  assertEqual(result.serviceCharge, { p1: 10, p2: 20 });
  assertEqual(result.amountOwed, { p1: 110, p2: 220 });
  assertEqual(result.amountOwed.p1 + result.amountOwed.p2, 330);
  assertEqual(result.unclaimedPence, 0);

  const vatInclusive = reconcileSharedBill({
    items: [{ id: 'meal', pricePence: 1000 }],
    claims: [{ itemId: 'meal', participantId: 'p1' }],
    participantIds: ['p1'],
    totalPence: 1000,
    serviceChargePence: 0,
  });
  assertEqual(vatInclusive.amountOwed, { p1: 1000 });
  assertEqual(vatInclusive.serviceCharge, { p1: 0 });
  assertEqual(vatInclusive.unclaimedPence, 0);
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
  throw new Error(`${failed} shared split test${failed === 1 ? '' : 's'} failed`);
}
