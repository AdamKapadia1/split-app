/**
 * Integer-pence settlement math.
 * Positive balance means the person is owed money. Negative means they owe money.
 * Every debit has a matching credit, so a group's balances always sum to zero.
 */

export type SettlementReceiptInput = {
  id: string;
  paid_by: string | null;
  created_at?: string;
  settled_at?: string | null;
};

export type PartitionReceiptInput = {
  id: string;
  created_at: string;
  settled_at?: string | null;
};

export type SettlementSource = 'manual' | 'automatic';

export type PartitionedReceipts<T> = {
  activeReceipts: T[];
  settledReceipts: T[];
  settlementSource: Record<string, SettlementSource>;
};

export type WatermarkReceiptInput = {
  id: string;
  paid_by: string | null;
  created_at: string;
};

export type WatermarkSettlementInput = SettlementRecordInput & {
  created_at: string;
};

export type SettlementSplitInput = {
  receipt_id: string;
  user_id: string;
  amount_minor: number;
};

export type SettlementRecordInput = {
  from_user_id: string;
  to_user_id: string;
  amount_minor: number;
  voided_at: string | null;
};

export type SimplifiedTransfer = {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
};

export function calculateNetBalances(
  receipts: readonly SettlementReceiptInput[],
  splits: readonly SettlementSplitInput[],
  settlements: readonly SettlementRecordInput[],
  memberIds: readonly string[],
): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const userId of memberIds) balances[userId] = 0;

  const receiptPayerMap = new Map<string, string | null>();
  for (const receipt of receipts) receiptPayerMap.set(receipt.id, receipt.paid_by);

  for (const split of splits) {
    const payerId = receiptPayerMap.get(split.receipt_id);
    if (!payerId || split.amount_minor <= 0) continue;

    ensureBalance(balances, payerId);
    ensureBalance(balances, split.user_id);
    balances[split.user_id] -= split.amount_minor;
    balances[payerId] += split.amount_minor;
  }

  for (const settlement of settlements) {
    if (settlement.voided_at !== null) continue;

    ensureBalance(balances, settlement.from_user_id);
    ensureBalance(balances, settlement.to_user_id);
    balances[settlement.from_user_id] += settlement.amount_minor;
    balances[settlement.to_user_id] -= settlement.amount_minor;
  }

  const sum = Object.values(balances).reduce((total, amount) => total + amount, 0);
  if (sum !== 0) {
    throw new Error('Settlement balances are not zero-sum.');
  }

  return balances;
}

export type GroupLedgerStatusKind = 'empty' | 'balances_owed' | 'needs_split' | 'settled';

export interface GroupLedgerStatus {
  kind: GroupLedgerStatusKind;
  receiptCount: number;
  activeReceiptCount: number;
  settledReceiptCount: number;
  unsplitActiveCount: number;
  transferCount: number;
  userNetBalanceMinor: number;
}

export type GroupLedgerReceiptInput = {
  id: string;
  created_at: string;
  paid_by: string | null;
  settled_at?: string | null;
};

/**
 * The only place a group is allowed to become "settled".
 * Empty groups and unsplit bills never take that path.
 * Balance math stays in `calculateNetBalances` and `simplifyDebts`.
 */
export function deriveGroupLedgerStatus({
  receipts,
  splits,
  settlements,
  memberIds,
  currentUserId,
}: {
  receipts: readonly GroupLedgerReceiptInput[];
  splits: readonly SettlementSplitInput[];
  settlements: readonly WatermarkSettlementInput[];
  memberIds: readonly string[];
  currentUserId: string | null | undefined;
}): GroupLedgerStatus {
  const splitReceiptIds = new Set<string>();
  for (const split of splits) {
    if (split.amount_minor > 0) splitReceiptIds.add(split.receipt_id);
  }

  const lastSettledAt = latestZeroBalanceAt(receipts, splits, settlements);
  const { activeReceipts, settledReceipts } = partitionGroupReceipts(receipts, splitReceiptIds, lastSettledAt);
  const unsplitActiveCount = activeReceipts.filter((receipt) => !splitReceiptIds.has(receipt.id)).length;
  const netBalances = calculateNetBalances(receipts, splits, settlements, memberIds);
  const simplifiedTransfers = simplifyDebts(netBalances);
  const userNetBalanceMinor = currentUserId ? (netBalances[currentUserId] ?? 0) : 0;

  let kind: GroupLedgerStatusKind;
  if (receipts.length === 0) {
    kind = 'empty';
  } else if (simplifiedTransfers.length > 0 || Object.values(netBalances).some((balance) => balance !== 0)) {
    kind = 'balances_owed';
  } else if (unsplitActiveCount > 0) {
    kind = 'needs_split';
  } else {
    kind = 'settled';
  }

  return {
    kind,
    receiptCount: receipts.length,
    activeReceiptCount: activeReceipts.length,
    settledReceiptCount: settledReceipts.length,
    unsplitActiveCount,
    transferCount: simplifiedTransfers.length,
    userNetBalanceMinor,
  };
}

export function simplifyDebts(netBalances: Record<string, number>): SimplifiedTransfer[] {
  const debtors: { userId: string; amount: number }[] = [];
  const creditors: { userId: string; amount: number }[] = [];

  for (const [userId, amount] of Object.entries(netBalances)) {
    if (amount < 0) debtors.push({ userId, amount: -amount });
    else if (amount > 0) creditors.push({ userId, amount });
  }

  debtors.sort(byAmountThenUserId);
  creditors.sort(byAmountThenUserId);

  const transfers: SimplifiedTransfer[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;

  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    if (!debtor || !creditor) break;

    const transfer = Math.min(debtor.amount, creditor.amount);
    if (transfer > 0) {
      transfers.push({
        fromUserId: debtor.userId,
        toUserId: creditor.userId,
        amountMinor: transfer,
      });
    }

    debtor.amount -= transfer;
    creditor.amount -= transfer;
    if (debtor.amount === 0) debtorIndex += 1;
    if (creditor.amount === 0) creditorIndex += 1;
  }

  return transfers;
}

/**
 * Splits receipts into the active list and settlement history.
 * Manual archive (`settled_at`) wins. Otherwise a split receipt is archived
 * when it was created at or before the last time a payment zeroed the group.
 * This does not change balances: callers must still pass every receipt into
 * `calculateNetBalances`.
 */
export function partitionGroupReceipts<T extends PartitionReceiptInput>(
  receipts: readonly T[],
  splitReceiptIds: ReadonlySet<string>,
  lastSettledAt: string | null,
): PartitionedReceipts<T> {
  const activeReceipts: T[] = [];
  const settledReceipts: T[] = [];
  const settlementSource: Record<string, SettlementSource> = {};
  const watermark = lastSettledAt === null ? null : new Date(lastSettledAt).getTime();

  for (const receipt of receipts) {
    if (receipt.settled_at) {
      settledReceipts.push(receipt);
      settlementSource[receipt.id] = 'manual';
      continue;
    }

    const createdAt = new Date(receipt.created_at).getTime();
    const automaticallySettled =
      watermark !== null
      && !Number.isNaN(watermark)
      && splitReceiptIds.has(receipt.id)
      && createdAt <= watermark;

    if (automaticallySettled) {
      settledReceipts.push(receipt);
      settlementSource[receipt.id] = 'automatic';
      continue;
    }

    activeReceipts.push(receipt);
  }

  return { activeReceipts, settledReceipts, settlementSource };
}

/**
 * Timestamp of the latest non-voided payment after which every balance was zero.
 * Later receipts can make the group non-zero again without moving this watermark
 * backwards. Returns null when no payment has cleared the group.
 */
export function latestZeroBalanceAt(
  receipts: readonly WatermarkReceiptInput[],
  splits: readonly SettlementSplitInput[],
  settlements: readonly WatermarkSettlementInput[],
): string | null {
  const splitsByReceipt = new Map<string, SettlementSplitInput[]>();
  for (const split of splits) {
    const existing = splitsByReceipt.get(split.receipt_id);
    if (existing) existing.push(split);
    else splitsByReceipt.set(split.receipt_id, [split]);
  }

  const events: { at: number; order: number; kind: 'receipt' | 'settlement'; index: number }[] = [];
  receipts.forEach((receipt, index) => {
    const at = new Date(receipt.created_at).getTime();
    if (Number.isNaN(at)) return;
    events.push({ at, order: 0, kind: 'receipt', index });
  });
  settlements.forEach((settlement, index) => {
    if (settlement.voided_at !== null) return;
    const at = new Date(settlement.created_at).getTime();
    if (Number.isNaN(at)) return;
    events.push({ at, order: 1, kind: 'settlement', index });
  });
  events.sort((left, right) => left.at - right.at || left.order - right.order || left.index - right.index);

  const balances: Record<string, number> = {};
  let watermark: string | null = null;

  for (const event of events) {
    if (event.kind === 'receipt') {
      const receipt = receipts[event.index];
      if (!receipt) continue;
      applyReceiptSplits(balances, receipt.paid_by, splitsByReceipt.get(receipt.id) ?? []);
      continue;
    }

    const settlement = settlements[event.index];
    if (!settlement) continue;
    ensureBalance(balances, settlement.from_user_id);
    ensureBalance(balances, settlement.to_user_id);
    balances[settlement.from_user_id] += settlement.amount_minor;
    balances[settlement.to_user_id] -= settlement.amount_minor;
    if (Object.values(balances).every((amount) => amount === 0)) {
      watermark = settlement.created_at;
    }
  }

  return watermark;
}

function applyReceiptSplits(
  balances: Record<string, number>,
  paidBy: string | null,
  splits: readonly SettlementSplitInput[],
) {
  if (!paidBy) return;
  for (const split of splits) {
    if (split.amount_minor <= 0) continue;
    ensureBalance(balances, paidBy);
    ensureBalance(balances, split.user_id);
    balances[split.user_id] -= split.amount_minor;
    balances[paidBy] += split.amount_minor;
  }
}

function ensureBalance(balances: Record<string, number>, userId: string) {
  if (balances[userId] === undefined) balances[userId] = 0;
}

function byAmountThenUserId(
  left: { userId: string; amount: number },
  right: { userId: string; amount: number },
) {
  if (left.amount !== right.amount) return right.amount - left.amount;
  if (left.userId < right.userId) return -1;
  if (left.userId > right.userId) return 1;
  return 0;
}
