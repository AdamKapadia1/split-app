import {
  manualBillLineItems,
  manualBillTotals,
  parseGBPToPence,
  penceToPounds,
  validateManualBill,
} from '../manualBill';

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

it('parses whole pounds, a single decimal, and pence', () => {
  assertEqual(parseGBPToPence('12.50'), 1250);
  assertEqual(parseGBPToPence('£8'), 800);
  assertEqual(parseGBPToPence('8.5'), 850);
  assertEqual(parseGBPToPence('12'), 1200);
  assertEqual(parseGBPToPence('12.5'), 1250);
  assertEqual(parseGBPToPence('0.99'), 99);
  assertEqual(parseGBPToPence('1,250.05'), 125005);
  assertEqual(parseGBPToPence(' £ 1,250.05 '), 125005);
});

it('rejects empty, zero, negative, extra decimals, and amounts above £50,000', () => {
  assertEqual(parseGBPToPence(''), null);
  assertEqual(parseGBPToPence('   '), null);
  assertEqual(parseGBPToPence('0'), null);
  assertEqual(parseGBPToPence('0.00'), null);
  assertEqual(parseGBPToPence('-5'), null);
  assertEqual(parseGBPToPence('£-5'), null);
  assertEqual(parseGBPToPence('12.345'), null);
  assertEqual(parseGBPToPence('abc'), null);
  assertEqual(parseGBPToPence('12.5.0'), null);
  assertEqual(parseGBPToPence('999999'), null);
  assertEqual(parseGBPToPence('50000'), 5_000_000);
  assertEqual(parseGBPToPence('50000.01'), null);
});

it('converts integer pence to decimal pounds that round-trip', () => {
  assertEqual(penceToPounds(1250), 12.5);
  assertEqual(penceToPounds(850), 8.5);
  assertEqual(penceToPounds(125005), 1250.05);
  assertEqual(Math.round(penceToPounds(125005) * 100), 125005);
  assertEqual(Math.round(penceToPounds(1) * 100), 1);
});

it('reports a missing merchant and an invalid total', () => {
  const missing = validateManualBill({ merchantName: '   ', totalInput: '8.00', items: [] });
  assertEqual(missing.ok, false);
  assertEqual(missing.bill, null);
  assertEqual(missing.errors.merchantName, 'Enter a merchant or description.');

  const invalid = validateManualBill({ merchantName: 'Uber home', totalInput: '12.345', items: [] });
  assertEqual(invalid.ok, false);
  assertEqual(invalid.errors.total, 'Enter an amount from £0.01 to £50,000.');
  assertEqual(invalid.bill, null);
});

it('accepts a lump-sum bill and builds one default line', () => {
  const result = validateManualBill({
    merchantName: '  Uber home  ',
    totalInput: '£8',
    items: [{ name: '   ', amountInput: '  ' }],
  });
  assertEqual(result.ok, true);
  assertEqual(result.errors, {});
  assertEqual(result.bill, {
    merchantName: 'Uber home',
    totalPence: 800,
    items: [],
  });
  if (!result.bill) throw new Error('expected a bill');
  assertEqual(manualBillLineItems(result.bill), [{ name: 'Uber home', amountPence: 800 }]);
  assertEqual(manualBillTotals(result.bill), { subtotalPence: 800, taxPence: 0, totalPence: 800 });
});

it('accepts an itemised bill and keeps the unpaid remainder as tax', () => {
  const result = validateManualBill({
    merchantName: 'The Evil Eye',
    totalInput: '12.50',
    items: [
      { name: ' Pint ', amountInput: '6' },
      { name: 'Pint', amountInput: '5.50' },
    ],
  });
  assertEqual(result.ok, true);
  assertEqual(result.bill, {
    merchantName: 'The Evil Eye',
    totalPence: 1250,
    items: [
      { name: 'Pint', amountPence: 600 },
      { name: 'Pint', amountPence: 550 },
    ],
  });
  if (!result.bill) throw new Error('expected a bill');
  assertEqual(manualBillTotals(result.bill), { subtotalPence: 1150, taxPence: 100, totalPence: 1250 });
});

it('rejects a partial item and items that exceed the total', () => {
  const partial = validateManualBill({
    merchantName: 'Taxi',
    totalInput: '20',
    items: [{ name: '', amountInput: '4.50' }],
  });
  assertEqual(partial.ok, false);
  assertEqual(partial.errors.items?.[0]?.name, 'Name this item.');

  const over = validateManualBill({
    merchantName: 'The Evil Eye',
    totalInput: '10',
    items: [
      { name: 'Round', amountInput: '8' },
      { name: 'Round', amountInput: '4' },
    ],
  });
  assertEqual(over.ok, false);
  assertEqual(over.errors.itemsTotal, 'Items add up to more than the total.');
  assertEqual(over.bill, null);
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
  throw new Error(`${failed} manual bill test${failed === 1 ? '' : 's'} failed`);
}
