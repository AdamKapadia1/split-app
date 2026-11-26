import { allocateCoClaimPence, calculateNetBalances, computeSplitLedger, deriveGroupLedgerStatus, latestZeroBalanceAt, partitionGroupReceipts, receiptNeedsSplit, receiptProgressLabel, simplifyDebts, type GroupLedgerReceiptInput, type SettlementRecordInput, type SettlementSplitInput, type SplitLedgerParticipant, type WatermarkSettlementInput } from '../settlements';
import { beginLocalMutation, captureEpoch, createSyncGate, finishLocalMutation, mayApplyRemoteSnapshot, splitSyncSignal } from '../splitSync';

const tests: { name: string; run: () => void }[] = [];
let currentSuite = '';

function describe(name: string, register: () => void) {
  const previous = currentSuite;
  currentSuite = name;
  register();
  currentSuite = previous;
}

function it(name: string, run: () => void) {
  tests.push({ name: currentSuite ? `${currentSuite}: ${name}` : name, run });
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

it('drops the payer’s own share from what anyone owes', () => {
  const balances = calculateNetBalances(
    [{ id: 'receipt-1', paid_by: 'sam' }],
    [
      { receipt_id: 'receipt-1', user_id: 'sam', amount_minor: 4000 },
      { receipt_id: 'receipt-1', user_id: 'alex', amount_minor: 6000 },
    ],
    [],
    ['alex', 'sam'],
  );

  assertEqual(balances, { alex: -6000, sam: 6000 });
  assertEqual(simplifyDebts(balances), [{ fromUserId: 'alex', toUserId: 'sam', amountMinor: 6000 }]);
});

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

it('archives a manually settled receipt even when the group has no payments', () => {
  const partitioned = partitionGroupReceipts(
    [{ id: 'receipt-1', created_at: '2026-11-01T12:00:00.000Z', settled_at: '2026-11-20T08:00:00.000Z' }],
    new Set<string>(),
    null,
  );

  assertEqual(partitioned.activeReceipts, []);
  assertEqual(partitioned.settledReceipts.map((receipt) => receipt.id), ['receipt-1']);
  assertEqual(partitioned.settlementSource, { 'receipt-1': 'manual' });
});

it('returns a reopened receipt to active unless a zero-balance watermark still covers it', () => {
  const reopened = {
    id: 'receipt-1',
    created_at: '2026-11-01T12:00:00.000Z',
    settled_at: null,
  };
  const splitIds = new Set(['receipt-1']);

  const active = partitionGroupReceipts([reopened], splitIds, null);
  assertEqual(active.activeReceipts.map((receipt) => receipt.id), ['receipt-1']);
  assertEqual(active.settledReceipts, []);

  const covered = partitionGroupReceipts([reopened], splitIds, '2026-11-02T00:00:00.000Z');
  assertEqual(covered.activeReceipts, []);
  assertEqual(covered.settledReceipts.map((receipt) => receipt.id), ['receipt-1']);
  assertEqual(covered.settlementSource['receipt-1'], 'automatic');

  const afterWatermark = partitionGroupReceipts(
    [{ ...reopened, created_at: '2026-11-03T00:00:00.000Z' }],
    splitIds,
    '2026-11-02T00:00:00.000Z',
  );
  assertEqual(afterWatermark.activeReceipts.map((receipt) => receipt.id), ['receipt-1']);
  assertEqual(afterWatermark.settledReceipts, []);

  const unsplit = partitionGroupReceipts(
    [{ ...reopened, id: 'unsplit' }],
    new Set<string>(),
    '2026-11-02T00:00:00.000Z',
  );
  assertEqual(unsplit.activeReceipts.map((receipt) => receipt.id), ['unsplit']);
});

it('keeps net balances and simplified debts unchanged when a receipt is manually archived', () => {
  const open = [{ id: 'receipt-1', paid_by: 'sam', created_at: '2026-11-01T12:00:00.000Z', settled_at: null }];
  const archived = [{ ...open[0], settled_at: '2026-11-20T08:00:00.000Z' }];
  const shares: SettlementSplitInput[] = [{ receipt_id: 'receipt-1', user_id: 'alex', amount_minor: 2450 }];
  const payments: SettlementRecordInput[] = [];
  const people = ['alex', 'sam'];

  const before = calculateNetBalances(open, shares, payments, people);
  const after = calculateNetBalances(archived, shares, payments, people);

  assertEqual(before, { alex: -2450, sam: 2450 });
  assertEqual(after, before);
  assertEqual(simplifyDebts(after), simplifyDebts(before));
  assertEqual(simplifyDebts(after), [{ fromUserId: 'alex', toUserId: 'sam', amountMinor: 2450 }]);

  const sum = Object.values(after).reduce((total, amount) => total + amount, 0);
  assertEqual(sum, 0);

  const partitioned = partitionGroupReceipts(archived, new Set(['receipt-1']), null);
  assertEqual(partitioned.settledReceipts.map((receipt) => receipt.id), ['receipt-1']);
  assertEqual(partitioned.settlementSource['receipt-1'], 'manual');
});

it('sets the automatic watermark on the latest payment that returns the group to zero', () => {
  const watermark = latestZeroBalanceAt(
    [
      { id: 'receipt-1', paid_by: 'sam', created_at: '2026-11-01T10:00:00.000Z' },
      { id: 'receipt-2', paid_by: 'sam', created_at: '2026-11-03T10:00:00.000Z' },
    ],
    [
      { receipt_id: 'receipt-1', user_id: 'alex', amount_minor: 1000 },
      { receipt_id: 'receipt-2', user_id: 'alex', amount_minor: 500 },
    ],
    [
      { ...settlement('alex', 'sam', 1000), created_at: '2026-11-02T10:00:00.000Z' },
      { ...settlement('alex', 'sam', 500), created_at: '2026-11-04T10:00:00.000Z' },
    ],
  );
  assertEqual(watermark, '2026-11-04T10:00:00.000Z');

  const open = latestZeroBalanceAt(
    [{ id: 'receipt-1', paid_by: 'sam', created_at: '2026-11-01T10:00:00.000Z' }],
    [{ receipt_id: 'receipt-1', user_id: 'alex', amount_minor: 1000 }],
    [],
  );
  assertEqual(open, null);

  const voided = latestZeroBalanceAt(
    [{ id: 'receipt-1', paid_by: 'sam', created_at: '2026-11-01T10:00:00.000Z' }],
    [{ receipt_id: 'receipt-1', user_id: 'alex', amount_minor: 1000 }],
    [{ ...settlement('alex', 'sam', 1000), voided_at: '2026-11-05T00:00:00.000Z', created_at: '2026-11-02T10:00:00.000Z' }],
  );
  assertEqual(voided, null);
});

describe('deriveGroupLedgerStatus', () => {
  const people = ['alex', 'sam'];

  function bill(id: string, createdAt: string, settledAt: string | null = null): GroupLedgerReceiptInput {
    return { id, paid_by: 'sam', created_at: createdAt, settled_at: settledAt };
  }

  function share(receiptId: string, amountMinor: number): SettlementSplitInput {
    return { receipt_id: receiptId, user_id: 'alex', amount_minor: amountMinor };
  }

  function payment(amountMinor: number, createdAt: string, voidedAt: string | null = null): WatermarkSettlementInput {
    return {
      from_user_id: 'alex',
      to_user_id: 'sam',
      amount_minor: amountMinor,
      voided_at: voidedAt,
      created_at: createdAt,
    };
  }

  it('treats a brand-new group as empty', () => {
    const status = deriveGroupLedgerStatus({
      receipts: [],
      splits: [],
      settlements: [],
      memberIds: people,
      currentUserId: 'alex',
    });

    assertEqual(status.kind, 'empty');
    assertEqual(status.unsplitActiveCount, 0);
    assertEqual(status.receiptCount, 0);
    assertEqual(status.userNetBalanceMinor, 0);
  });

  it('keeps a newly scanned unsplit receipt out of settled', () => {
    const status = deriveGroupLedgerStatus({
      receipts: [bill('mollie', '2026-11-20T19:00:00.000Z')],
      splits: [],
      settlements: [],
      memberIds: people,
      currentUserId: 'alex',
    });

    assertEqual(status.kind, 'needs_split');
    assertEqual(status.unsplitActiveCount, 1);
    assertEqual(status.userNetBalanceMinor, 0);
    assertEqual(status.transferCount, 0);
  });

  it('drops a share-ledger split or settled receipt from the to-split count', () => {
    const split = deriveGroupLedgerStatus({
      receipts: [{ ...bill('mollie', '2026-11-20T19:00:00.000Z'), status: 'split' }],
      splits: [],
      settlements: [],
      memberIds: people,
      currentUserId: 'alex',
    });
    assertEqual(split.unsplitActiveCount, 0);
    assertEqual(split.kind, 'settled');

    const settled = deriveGroupLedgerStatus({
      receipts: [{ ...bill('mollie', '2026-11-20T19:00:00.000Z', '2026-11-21T09:00:00.000Z'), status: 'settled' }],
      splits: [],
      settlements: [],
      memberIds: people,
      currentUserId: 'alex',
    });
    assertEqual(settled.unsplitActiveCount, 0);
    assertEqual(settled.kind, 'settled');
    assertEqual(settled.activeReceiptCount, 0);
  });

  it('still needs a split when another receipt was archived by hand', () => {
    const status = deriveGroupLedgerStatus({
      receipts: [
        bill('open', '2026-11-20T19:00:00.000Z'),
        bill('archived', '2026-11-18T19:00:00.000Z', '2026-11-19T09:00:00.000Z'),
      ],
      splits: [],
      settlements: [],
      memberIds: people,
      currentUserId: 'alex',
    });

    assertEqual(status.kind, 'needs_split');
    assertEqual(status.unsplitActiveCount, 1);
    assertEqual(status.activeReceiptCount, 1);
    assertEqual(status.settledReceiptCount, 1);
  });

  it('settles a group whose only receipt was marked settled', () => {
    const status = deriveGroupLedgerStatus({
      receipts: [bill('archived', '2026-11-18T19:00:00.000Z', '2026-11-19T09:00:00.000Z')],
      splits: [],
      settlements: [],
      memberIds: people,
      currentUserId: 'sam',
    });

    assertEqual(status.kind, 'settled');
    assertEqual(status.unsplitActiveCount, 0);
    assertEqual(status.settledReceiptCount, 1);
    assertEqual(status.userNetBalanceMinor, 0);
  });

  it('lets an open debt outrank an unsplit receipt', () => {
    const status = deriveGroupLedgerStatus({
      receipts: [
        bill('split', '2026-11-01T10:00:00.000Z'),
        bill('open', '2026-11-03T10:00:00.000Z'),
      ],
      splits: [share('split', 3806)],
      settlements: [],
      memberIds: people,
      currentUserId: 'alex',
    });

    assertEqual(status.kind, 'balances_owed');
    assertEqual(status.unsplitActiveCount, 1);
    assertEqual(status.transferCount, 1);
    assertEqual(status.userNetBalanceMinor, -3806);
  });

  it('settles only after every split is paid off and no unsplit receipt remains', () => {
    const status = deriveGroupLedgerStatus({
      receipts: [bill('split', '2026-11-01T10:00:00.000Z')],
      splits: [share('split', 3806)],
      settlements: [payment(3806, '2026-11-02T10:00:00.000Z')],
      memberIds: people,
      currentUserId: 'alex',
    });

    assertEqual(status.kind, 'settled');
    assertEqual(status.unsplitActiveCount, 0);
    assertEqual(status.transferCount, 0);
    assertEqual(status.userNetBalanceMinor, 0);
    assertEqual(status.activeReceiptCount, 0);
    assertEqual(status.settledReceiptCount, 1);
  });

  it('reopens balances when a clearing settlement is voided', () => {
    const status = deriveGroupLedgerStatus({
      receipts: [bill('split', '2026-11-01T10:00:00.000Z')],
      splits: [share('split', 3806)],
      settlements: [payment(3806, '2026-11-02T10:00:00.000Z', '2026-11-05T10:00:00.000Z')],
      memberIds: people,
      currentUserId: 'alex',
    });

    assertEqual(status.kind, 'balances_owed');
    assertEqual(status.unsplitActiveCount, 0);
    assertEqual(status.userNetBalanceMinor, -3806);
    assertEqual(status.transferCount, 1);
  });
});

describe('split countdown ledger', () => {
  const items = [
    { id: 'steak', pricePence: 1000 },
    { id: 'pasta', pricePence: 1000 },
    { id: 'salad', pricePence: 1000 },
  ];
  const people = (paidGuest2 = false): SplitLedgerParticipant[] => [
    { id: 'host', isHost: true, paid: false },
    { id: 'g1', isHost: false, paid: true },
    { id: 'g2', isHost: false, paid: paidGuest2 },
  ];

  it('walks the bill down to £0.00 as the host confirms and guests pay', () => {
    const opened = computeSplitLedger({
      receiptTotalPence: 3000,
      items,
      claims: [],
      participants: people(),
      hostConfirmed: false,
    });
    assertEqual(opened.receiptTotalPence, 3000);
    assertEqual(opened.hostConfirmedPence, 0);
    assertEqual(opened.remainingToSplitPence, 3000);
    assertEqual(opened.remainingUnclaimedPence, 3000);
    assertEqual(opened.isAllSettled, false);
    assertBalances(opened);

    const hostSelecting = computeSplitLedger({
      receiptTotalPence: 3000,
      items,
      claims: [],
      participants: people(),
      hostConfirmed: false,
      hostPreviewItemIds: ['steak'],
    });
    assertEqual(hostSelecting.hostConfirmedPence, 1000);
    assertEqual(hostSelecting.hostPendingPreviewPence, 1000);
    assertEqual(hostSelecting.remainingToSplitPence, 2000);
    assertEqual(hostSelecting.remainingUnclaimedPence, 2000);
    assertBalances(hostSelecting);

    const hostConfirmed = computeSplitLedger({
      receiptTotalPence: 3000,
      items,
      claims: [{ itemId: 'steak', participantId: 'host' }],
      participants: people(),
      hostConfirmed: true,
    });
    assertEqual(hostConfirmed.hostConfirmedPence, 1000);
    assertEqual(hostConfirmed.hostPendingPreviewPence, 0);
    assertEqual(hostConfirmed.remainingToSplitPence, 2000);
    assertBalances(hostConfirmed);

    const guestPaid = computeSplitLedger({
      receiptTotalPence: 3000,
      items,
      claims: [
        { itemId: 'steak', participantId: 'host' },
        { itemId: 'pasta', participantId: 'g1' },
      ],
      participants: people(),
      hostConfirmed: true,
    });
    assertEqual(guestPaid.guestPaidPence, 1000);
    assertEqual(guestPaid.remainingToSplitPence, 1000);
    assertEqual(guestPaid.remainingOwedToHostPence, 1000);
    assertEqual(guestPaid.remainingUnclaimedPence, 1000);
    assertBalances(guestPaid);

    const settled = computeSplitLedger({
      receiptTotalPence: 3000,
      items,
      claims: [
        { itemId: 'steak', participantId: 'host' },
        { itemId: 'steak', participantId: 'g2' },
        { itemId: 'pasta', participantId: 'g1' },
        { itemId: 'salad', participantId: 'g2' },
      ],
      participants: people(true),
      hostConfirmed: true,
    });
    assertEqual(settled.hostConfirmedPence, 500);
    assertEqual(settled.guestPaidPence, 2500);
    assertEqual(settled.guestClaimedUnpaidPence, 0);
    assertEqual(settled.remainingUnclaimedPence, 0);
    assertEqual(settled.remainingToSplitPence, 0);
    assertEqual(settled.remainingOwedToHostPence, 0);
    assertEqual(settled.isAllSettled, true);
    assertEqual(settled.itemsClaimed, 3);
    assertBalances(settled);
  });

  it('splits £10.00 three ways with no leftover penny', () => {
    const shares = allocateCoClaimPence(1000, ['a', 'b', 'host']);
    assertEqual(shares, { a: 334, b: 333, host: 333 });
    assertEqual(Object.values(shares).reduce((sum, amount) => sum + amount, 0), 1000);

    const ledger = computeSplitLedger({
      receiptTotalPence: 1000,
      items: [{ id: 'dish', pricePence: 1000 }],
      claims: [
        { itemId: 'dish', participantId: 'a' },
        { itemId: 'dish', participantId: 'b' },
        { itemId: 'dish', participantId: 'host' },
      ],
      participants: [
        { id: 'host', isHost: true, paid: false },
        { id: 'a', isHost: false, paid: false },
        { id: 'b', isHost: false, paid: false },
      ],
      hostConfirmed: true,
    });
    assertEqual(ledger.hostConfirmedPence, 333);
    assertEqual(ledger.guestClaimedUnpaidPence, 667);
    assertEqual(ledger.guestPaidPence, 0);
    assertEqual(ledger.remainingUnclaimedPence, 0);
    assertBalances(ledger);
    assertEqual(ledger.isAllSettled, false);
  });

  it('spreads a service charge across items before claims are split', () => {
    const ledger = computeSplitLedger({
      receiptTotalPence: 1100,
      items: [
        { id: 'one', pricePence: 500 },
        { id: 'two', pricePence: 500 },
      ],
      claims: [
        { itemId: 'one', participantId: 'host' },
        { itemId: 'two', participantId: 'guest' },
      ],
      participants: [
        { id: 'host', isHost: true, paid: false },
        { id: 'guest', isHost: false, paid: true },
      ],
      hostConfirmed: true,
    });
    assertEqual(ledger.hostConfirmedPence + ledger.guestPaidPence + ledger.guestClaimedUnpaidPence + ledger.remainingUnclaimedPence, 1100);
    assertEqual(ledger.remainingUnclaimedPence, 0);
    assertEqual(ledger.hostConfirmedPence, 550);
    assertEqual(ledger.guestPaidPence, 550);
    assertEqual(ledger.isAllSettled, true);
  });

  it('keeps a guest paid flag when the host edits items afterwards', () => {
    const guest: SplitLedgerParticipant = { id: 'g1', isHost: false, paid: true };
    const participants = [{ id: 'host', isHost: true, paid: false }, guest];
    const before = computeSplitLedger({
      receiptTotalPence: 3000,
      items,
      claims: [
        { itemId: 'steak', participantId: 'host' },
        { itemId: 'pasta', participantId: 'g1' },
      ],
      participants,
      hostConfirmed: true,
      hostPreviewItemIds: ['steak', 'salad'],
    });
    assertEqual(before.guestPaidPence, 1000);
    assertEqual(before.hostPendingPreviewPence, 2000);
    assertEqual(guest.paid, true);

    const after = computeSplitLedger({
      receiptTotalPence: 3000,
      items,
      claims: [
        { itemId: 'steak', participantId: 'host' },
        { itemId: 'salad', participantId: 'host' },
        { itemId: 'pasta', participantId: 'g1' },
      ],
      participants,
      hostConfirmed: true,
    });
    assertEqual(guest.paid, true);
    assertEqual(after.guestPaidPence, 1000);
    assertEqual(after.hostConfirmedPence, 2000);
    assertEqual(after.remainingUnclaimedPence, 0);
    assertEqual(after.isAllSettled, true);
    assertBalances(after);
  });

  it('drops a stale refetch that overlaps a local mutation', () => {
    const gate = createSyncGate();
    const seenBeforeTap = captureEpoch(gate);
    beginLocalMutation(gate);
    const seenDuringTap = captureEpoch(gate);
    assertEqual(mayApplyRemoteSnapshot(gate, seenBeforeTap), false);
    assertEqual(mayApplyRemoteSnapshot(gate, seenDuringTap), false);
    finishLocalMutation(gate);
    assertEqual(mayApplyRemoteSnapshot(gate, seenDuringTap), false);
    assertEqual(mayApplyRemoteSnapshot(gate, captureEpoch(gate)), true);
    assertEqual(splitSyncSignal({
      share_token: 'abcdefghijklmnopqrst',
      event_type: 'UPDATE',
      ts: '2026-11-26T12:00:00.000Z',
      display_name: 'Ada',
      amount_pence: 500,
    })?.share_token, 'abcdefghijklmnopqrst');
    assertEqual(splitSyncSignal({ event_type: 'UPDATE', ts: '2026-11-26T12:00:00.000Z' }), null);
  });
});

function assertBalances(state: ReturnType<typeof computeSplitLedger>) {
  assertEqual(
    state.hostConfirmedPence + state.guestClaimedUnpaidPence + state.guestPaidPence + state.remainingUnclaimedPence,
    state.receiptTotalPence,
  );
}

function settlement(fromUserId: string, toUserId: string, amountMinor: number): SettlementRecordInput {
  return {
    from_user_id: fromUserId,
    to_user_id: toUserId,
    amount_minor: amountMinor,
    voided_at: null,
  };
}

it('derives to-split badges for missing, empty, and unknown receipt fields', () => {
  assertEqual(receiptNeedsSplit(null, new Set()), false);
  assertEqual(receiptNeedsSplit(undefined, null), false);
  assertEqual(receiptNeedsSplit({ id: 'bill', status: null }, new Set()), true);
  assertEqual(receiptNeedsSplit({ id: 'bill', status: '' }, new Set()), true);
  assertEqual(receiptNeedsSplit({ id: 'bill', status: 'unknown' }, new Set()), true);
  assertEqual(receiptNeedsSplit({ id: 'bill', status: 'split' }, new Set()), false);
  assertEqual(receiptNeedsSplit({ id: 'bill', status: ' SETTLED ' }, new Set()), false);
  assertEqual(receiptNeedsSplit({ id: 'bill', status: 'open' }, new Set(['bill'])), false);

  assertEqual(receiptProgressLabel(null, false), 'Unsplit');
  assertEqual(receiptProgressLabel(undefined, true), 'Split');
  assertEqual(receiptProgressLabel({ status: null, settled_at: null }, false), 'Unsplit');
  assertEqual(receiptProgressLabel({ status: '', settled_at: '' }, false), 'Unsplit');
  assertEqual(receiptProgressLabel({ status: 'nope' }, false), 'Unsplit');
  assertEqual(receiptProgressLabel({ status: 'split', settled_at: null }, false), 'Split');
  assertEqual(receiptProgressLabel({ settled_at: '2026-11-21T09:00:00.000Z' }, false), 'Settled');

  const status = deriveGroupLedgerStatus({
    receipts: [
      null,
      { id: 'open', created_at: '2026-11-20T19:00:00.000Z', paid_by: null, status: undefined, settled_at: undefined },
    ] as unknown as GroupLedgerReceiptInput[],
    splits: null,
    settlements: undefined,
    memberIds: null,
    currentUserId: null,
  });
  assertEqual(status.kind, 'needs_split');
  assertEqual(status.unsplitActiveCount, 1);
  assertEqual(status.userNetBalanceMinor, 0);
  assertEqual(calculateNetBalances(null, undefined, null, undefined), {});
  assertEqual(simplifyDebts(null), []);
  assertEqual(partitionGroupReceipts(null, null, null).activeReceipts, []);
  assertEqual(latestZeroBalanceAt(null, null, null), null);
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
  throw new Error(`${failed} settlement test${failed === 1 ? '' : 's'} failed`);
}
