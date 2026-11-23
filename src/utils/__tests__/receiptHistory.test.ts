import { formatSmartDate } from '../formatSmartDate';
import { formatPence } from '../money';
import {
  buildReceiptHistoryKeysetFilter,
  collapseHistoryToPreview,
  escapeIlikePattern,
  filterAndGroupReceipts,
  getInitialHistoryLimit,
  HISTORY_PAGE_SIZE,
  HISTORY_PREVIEW_LIMIT,
  HISTORY_SEARCH_MAX_LENGTH,
  isHistoryFiltered,
  isValidGroupUuid,
  mergePaginatedReceipts,
  normalizeHistorySearchQuery,
  reconcileGroupFilter,
  sliceLookaheadPage,
  type HistoryReceiptInput,
} from '../receiptHistory';

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

function pageRow(id: string, createdAt: string, copy = id) {
  return { id, created_at: createdAt, copy };
}

it('reads a lookahead page without inventing a next page', () => {
  assertEqual(sliceLookaheadPage([], 5), { items: [], hasMore: false, nextCursor: null });

  const three = [pageRow('c', '2026-11-20T12:00:03.000Z'), pageRow('b', '2026-11-20T12:00:02.000Z'), pageRow('a', '2026-11-20T12:00:01.000Z')];
  const short = sliceLookaheadPage(three, 5);
  assertEqual(short.hasMore, false);
  assertEqual(short.nextCursor, null);
  assertEqual(short.items.map((row) => row.id), ['c', 'b', 'a']);

  const five = [
    pageRow('e', '2026-11-20T12:00:05.000Z'),
    pageRow('d', '2026-11-20T12:00:04.000Z'),
    pageRow('c', '2026-11-20T12:00:03.000Z'),
    pageRow('b', '2026-11-20T12:00:02.000Z'),
    pageRow('a', '2026-11-20T12:00:01.000Z'),
  ];
  const exact = sliceLookaheadPage(five, 5);
  assertEqual(exact.hasMore, false);
  assertEqual(exact.nextCursor, null);
  assertEqual(exact.items.length, 5);

  const six = [...five, pageRow('z', '2026-11-20T12:00:00.000Z')];
  const more = sliceLookaheadPage(six, 5);
  assertEqual(more.hasMore, true);
  assertEqual(more.items.map((row) => row.id), ['e', 'd', 'c', 'b', 'a']);
  assertEqual(more.nextCursor, { createdAt: '2026-11-20T12:00:01.000Z', id: 'a' });
});

it('appends the next page, keeps the incoming copy, and orders ties by id descending', () => {
  const newer = '2026-11-21T12:00:00.000Z';
  const same = '2026-11-20T12:00:00.000Z';
  const older = '2026-11-19T12:00:00.000Z';
  const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const idC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const idD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  const merged = mergePaginatedReceipts(
    [pageRow(idA, newer, 'page-1-a'), pageRow(idB, same, 'page-1-b')],
    [pageRow(idB, same, 'page-2-b'), pageRow(idC, same, 'page-2-c'), pageRow(idD, older, 'page-2-d')],
  );

  assertEqual(merged.map((row) => row.id), [idA, idC, idB, idD]);
  assertEqual(merged.map((row) => row.copy), ['page-1-a', 'page-2-c', 'page-2-b', 'page-2-d']);
  assertEqual(new Set(merged.map((row) => row.id)).size, merged.length);
});

it('collapses a loaded ledger back to the five-receipt preview', () => {
  const loaded = Array.from({ length: 12 }, (_, index) => {
    const position = 12 - index;
    return pageRow(
      `00000000-0000-4000-8000-${String(position).padStart(12, '0')}`,
      `2026-11-20T12:${String(position).padStart(2, '0')}:00.000Z`,
    );
  });

  const collapsed = collapseHistoryToPreview(loaded, false);
  assertEqual(collapsed.items.length, 5);
  assertEqual(collapsed.hasMore, true);
  assertEqual(collapsed.nextCursor, {
    createdAt: loaded[4]?.created_at,
    id: loaded[4]?.id,
  });
  assertEqual(collapsed.items.map((row) => row.id), loaded.slice(0, 5).map((row) => row.id));

  const short = collapseHistoryToPreview(loaded.slice(0, 4), false);
  assertEqual(short.items.length, 4);
  assertEqual(short.hasMore, false);
  assertEqual(short.nextCursor, null);
});

it('quotes keyset values and rejects a cursor that could rewrite the filter', () => {
  const createdAt = '2026-11-20T12:00:00.000Z';
  const id = '11111111-1111-4111-8111-111111111111';
  assertEqual(
    buildReceiptHistoryKeysetFilter({ createdAt, id }),
    `created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",id.lt."${id}")`,
  );

  let rejected = false;
  try {
    buildReceiptHistoryKeysetFilter({ createdAt: `${createdAt},id.gt.injected`, id: 'not-a-uuid' });
  } catch {
    rejected = true;
  }
  assertTrue(rejected, 'expected a malformed cursor to be rejected');
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

it('normalizes a history search before it is sent to the ledger', () => {
  assertEqual(normalizeHistorySearchQuery('  Nando   \t  House \n '), 'Nando House');
  assertEqual(normalizeHistorySearchQuery('Mollie\u2019s'), "Mollie's");
  assertEqual(normalizeHistorySearchQuery('\u201CMollie\u2019s\u201D'), '"Mollie\'s"');
  assertEqual(normalizeHistorySearchQuery('   '), '');
  assertEqual(normalizeHistorySearchQuery(''), '');
  assertEqual(normalizeHistorySearchQuery('\n\t'), '');

  const capped = normalizeHistorySearchQuery(`  ${'a'.repeat(HISTORY_SEARCH_MAX_LENGTH + 40)}  `);
  assertEqual(capped.length, HISTORY_SEARCH_MAX_LENGTH);
  assertEqual(capped, 'a'.repeat(HISTORY_SEARCH_MAX_LENGTH));
});

it('escapes LIKE wildcards without mangling ordinary merchant names', () => {
  assertEqual(escapeIlikePattern("Nando's"), "Nando's");
  assertEqual(escapeIlikePattern('M&S'), 'M&S');
  assertEqual(escapeIlikePattern('50%'), '50\\%');
  assertEqual(escapeIlikePattern('M_S'), 'M\\_S');
  assertEqual(escapeIlikePattern('A\\B'), 'A\\\\B');
  assertEqual(escapeIlikePattern('50% Off_Cafe\\UK'), '50\\% Off\\_Cafe\\\\UK');
});

it('accepts only canonical group UUIDs', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assertTrue(isValidGroupUuid(id), 'expected a lowercase uuid');
  assertTrue(isValidGroupUuid(id.toUpperCase()), 'expected an uppercase uuid');
  assertTrue(!isValidGroupUuid(''), 'empty string');
  assertTrue(!isValidGroupUuid('all'), 'all sentinel');
  assertTrue(!isValidGroupUuid('ungrouped'), 'ungrouped sentinel');
  assertTrue(!isValidGroupUuid(`${id}' OR true --`), 'sql payload');
  assertTrue(!isValidGroupUuid(`${id},group_id.eq.injected`), 'postgrest payload');
  assertTrue(!isValidGroupUuid('not-a-uuid'), 'plain text');
});

it('uses the preview limit until a search or group chip is active', () => {
  assertEqual(HISTORY_PREVIEW_LIMIT, 5);
  assertEqual(HISTORY_PAGE_SIZE, 15);
  assertEqual(isHistoryFiltered({ searchQuery: '   ', groupFilter: 'all' }), false);
  assertEqual(getInitialHistoryLimit({ searchQuery: '   ', groupFilter: 'all' }), 5);
  assertEqual(isHistoryFiltered({ searchQuery: '  nando  ', groupFilter: 'all' }), true);
  assertEqual(getInitialHistoryLimit({ searchQuery: '  nando  ', groupFilter: 'all' }), 15);
  assertEqual(getInitialHistoryLimit({ searchQuery: '', groupFilter: 'ungrouped' }), 15);
  assertEqual(
    getInitialHistoryLimit({ searchQuery: '', groupFilter: '11111111-1111-4111-8111-111111111111' }),
    15,
  );
});

it('keeps all and ungrouped chips, and drops a group the member no longer has', () => {
  const kept = '11111111-1111-4111-8111-111111111111';
  const missing = '22222222-2222-4222-8222-222222222222';
  const available = [kept];
  assertEqual(reconcileGroupFilter('all', available), 'all');
  assertEqual(reconcileGroupFilter('ungrouped', []), 'ungrouped');
  assertEqual(reconcileGroupFilter(kept, available), kept);
  assertEqual(reconcileGroupFilter(missing, available), 'all');
  assertEqual(reconcileGroupFilter(missing, []), 'all');
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
  throw new Error(`${failed} receipt history test${failed === 1 ? '' : 's'} failed`);
}
