import { formatSmartDate } from '../formatSmartDate';
import { formatPence } from '../money';
import { filterAndGroupReceipts, type HistoryReceiptInput } from '../receiptHistory';

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

function receipt(overrides: Partial<HistoryReceiptInput> & Pick<HistoryReceiptInput, 'id'>): HistoryReceiptInput {
  return {
    group_id: null,
    group_name: null,
    merchant_name: 'Cafe',
    total_minor: 0,
    created_at: '2026-11-20T12:00:00.000Z',
    ...overrides,
  };
}

it('matches merchant, group, pound amount, plain amount, and smart date', () => {
  const today = new Date();
  const november = new Date(today.getFullYear(), 10, 3, 15, 0, 0);
  const novemberLabel = formatSmartDate(november.toISOString()).toLowerCase();
  assertTrue(novemberLabel.includes('nov'), `expected a November label, received ${novemberLabel}`);

  const rows = [
    receipt({
      id: 'nando',
      merchant_name: "Nando's",
      group_id: 'group-house',
      group_name: 'House',
      total_minor: 3806,
      created_at: today.toISOString(),
    }),
    receipt({
      id: 'market',
      merchant_name: 'Borough Market',
      group_id: 'group-trip',
      group_name: 'Manchester',
      total_minor: 1200,
      created_at: november.toISOString(),
    }),
    receipt({
      id: 'personal',
      merchant_name: 'Tesco',
      total_minor: 499,
      created_at: '2026-01-02T12:00:00.000Z',
    }),
  ];

  assertEqual(filterAndGroupReceipts({ receipts: rows, searchQuery: 'nando', selectedGroupKey: 'all' }).filteredCount, 1);
  assertEqual(filterAndGroupReceipts({ receipts: rows, searchQuery: 'MANCH', selectedGroupKey: 'all' }).filteredCount, 1);
  assertEqual(filterAndGroupReceipts({ receipts: rows, searchQuery: '38.06', selectedGroupKey: 'all' }).sections[0]?.data[0]?.id, 'nando');
  assertEqual(filterAndGroupReceipts({ receipts: rows, searchQuery: '£38', selectedGroupKey: 'all' }).sections[0]?.data[0]?.id, 'nando');
  assertEqual(formatPence(3806), '£38.06');
  assertEqual(filterAndGroupReceipts({ receipts: rows, searchQuery: 'today', selectedGroupKey: 'all' }).sections[0]?.data[0]?.id, 'nando');
  assertEqual(filterAndGroupReceipts({ receipts: rows, searchQuery: 'nov', selectedGroupKey: 'all' }).sections[0]?.data[0]?.id, 'market');
  assertEqual(filterAndGroupReceipts({ receipts: rows, searchQuery: 'personal', selectedGroupKey: 'all' }).sections[0]?.data[0]?.id, 'personal');
});

it('isolates one group or personal receipts', () => {
  const rows = [
    receipt({ id: 'a', group_id: 'group-a', group_name: 'Alpha', total_minor: 100 }),
    receipt({ id: 'b', group_id: 'group-b', group_name: 'Beta', total_minor: 200 }),
    receipt({ id: 'p', merchant_name: 'Corner Shop', total_minor: 300 }),
  ];

  const alpha = filterAndGroupReceipts({ receipts: rows, searchQuery: '', selectedGroupKey: 'group-a' });
  assertEqual(alpha.filteredCount, 1);
  assertEqual(alpha.sections.map((section) => section.key), ['group-a']);
  assertEqual(alpha.sections[0]?.data.map((row) => row.id), ['a']);

  const personal = filterAndGroupReceipts({ receipts: rows, searchQuery: '', selectedGroupKey: 'personal' });
  assertEqual(personal.filteredCount, 1);
  assertEqual(personal.sections[0]?.groupId, null);
  assertEqual(personal.sections[0]?.title, 'Personal');
  assertEqual(personal.sections[0]?.data.map((row) => row.id), ['p']);
});

it('sums section subtotals and the filtered total in exact integer pence', () => {
  const rows = [
    receipt({ id: 'a1', group_id: 'group-a', group_name: 'Alpha', total_minor: 1 }),
    receipt({ id: 'a2', group_id: 'group-a', group_name: 'Alpha', total_minor: 1001 }),
    receipt({ id: 'a3', group_id: 'group-a', group_name: 'Alpha', total_minor: 2002 }),
    receipt({ id: 'p1', total_minor: 50 }),
    receipt({ id: 'b1', group_id: 'group-b', group_name: 'Beta', total_minor: 99999999 }),
  ];

  const ledger = filterAndGroupReceipts({ receipts: rows, searchQuery: '', selectedGroupKey: 'all' });
  const alpha = ledger.sections.find((section) => section.key === 'group-a');
  const beta = ledger.sections.find((section) => section.key === 'group-b');
  const personal = ledger.sections.find((section) => section.key === 'personal');

  assertEqual(alpha?.subtotalMinor, 3004);
  assertEqual(beta?.subtotalMinor, 99999999);
  assertEqual(personal?.subtotalMinor, 50);
  assertEqual(ledger.filteredTotalMinor, 3004 + 99999999 + 50);
  assertEqual(
    ledger.filteredTotalMinor,
    ledger.sections.reduce((sum, section) => sum + section.subtotalMinor, 0),
  );
  assertTrue(Number.isSafeInteger(ledger.filteredTotalMinor), 'filtered total left the safe integer range');
});

it('orders sections and rows by most recent activity', () => {
  const rows = [
    receipt({ id: 'a-old', group_id: 'group-a', group_name: 'Alpha', created_at: '2026-11-01T09:00:00.000Z', total_minor: 10 }),
    receipt({ id: 'b-new', group_id: 'group-b', group_name: 'Beta', created_at: '2026-11-18T09:00:00.000Z', total_minor: 20 }),
    receipt({ id: 'a-mid', group_id: 'group-a', group_name: 'Alpha', created_at: '2026-11-10T09:00:00.000Z', total_minor: 30 }),
    receipt({ id: 'p-newest', created_at: '2026-11-19T09:00:00.000Z', total_minor: 40 }),
  ];

  const ledger = filterAndGroupReceipts({ receipts: rows, searchQuery: '', selectedGroupKey: 'all' });
  assertEqual(ledger.sections.map((section) => section.key), ['personal', 'group-b', 'group-a']);
  assertEqual(ledger.sections.find((section) => section.key === 'group-a')?.data.map((row) => row.id), ['a-mid', 'a-old']);
});

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
  throw new Error(`${failed} receipt history test${failed === 1 ? '' : 's'} failed`);
}
