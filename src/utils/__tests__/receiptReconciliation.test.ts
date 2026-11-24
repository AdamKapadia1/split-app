import { receiptDiscrepancy, reconcileScannedReceipt, splitExtrasMinor } from '../receiptReconciliation';

const tests: { name: string; run: () => void }[] = [];

function it(name: string, run: () => void) {
  tests.push({ name, run });
}

function assertEqual(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right} but received ${left}`);
}

it('keeps the first product line under the header', () => {
  const receipt = reconcileScannedReceipt({
    items: [
      { name: '1 Latte', price: 3.8 },
      { name: '2 Cappuccino', price: 7.6 },
    ],
    subtotal: 11.4,
    tax: 0,
    total: 11.4,
  });
  assertEqual(receipt.items.map((item) => item.name), ['1 Latte', '2 Cappuccino']);
  assertEqual(receipt.subtotal, 11.4);
  assertEqual(receipt.total, 11.4);
});

it('maps Standard VAT and SubTotal Net without treating them as items or the gross total', () => {
  const receipt = reconcileScannedReceipt({
    items: [
      { name: '1 Latte', price: 3.8 },
      { name: '2 Cappuccino', price: 7.6 },
      { name: 'SubTotal Net', price: 9.5 },
      { name: 'Standard', price: 1.9 },
    ],
    subtotal: 9.5,
    tax: 0,
    total: 9.5,
  });
  assertEqual(receipt.items.map((item) => item.name), ['1 Latte', '2 Cappuccino']);
  assertEqual(receipt.subtotal, 11.4);
  assertEqual(receipt.tax, 1.9);
  assertEqual(receipt.total, 11.4);
});

it('does not use a VAT figure as the amount due when the lines already include it', () => {
  const receipt = reconcileScannedReceipt({
    items: [
      { name: '1 Latte', price: 6.5 },
      { name: '2 Cappuccino', price: 8.4 },
      { name: 'Standard', price: 12.48 },
    ],
    subtotal: 14.9,
    tax: 12.48,
    total: 12.48,
  });
  assertEqual(receipt.items.length, 2);
  assertEqual(receipt.tax, 12.48);
  assertEqual(receipt.total, 14.9);
  assertEqual(receiptDiscrepancy(1490, Math.round(receipt.total * 100)).matches, true);
});

it('reports a penny-accurate gap between the itemised sum and the receipt total', () => {
  const gap = receiptDiscrepancy(1140, 1250);
  assertEqual(gap.matches, false);
  assertEqual(gap.differenceMinor, 110);
  assertEqual(receiptDiscrepancy(1140, 1141).matches, true);
  assertEqual(splitExtrasMinor(1140, 1250, 'items'), 0);
  assertEqual(splitExtrasMinor(1140, 1250, 'receipt'), 110);
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
  throw new Error(`${failed} receipt reconciliation test${failed === 1 ? '' : 's'} failed`);
}
