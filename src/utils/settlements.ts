/**
 * Integer-pence settlement math.
 * Positive balance means the person is owed money. Negative means they owe money.
 * Every debit has a matching credit, so a group's balances always sum to zero.
 */

import { allocateLargestRemainder, splitEquallyDeterministic } from './sharedSplitMath';

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
  receipts: readonly SettlementReceiptInput[] | null | undefined,
  splits: readonly SettlementSplitInput[] | null | undefined,
  settlements: readonly SettlementRecordInput[] | null | undefined,
  memberIds: readonly string[] | null | undefined,
): Record<string, number> {
  const balances: Record<string, number> = {};
  for (const userId of Array.isArray(memberIds) ? memberIds : []) {
    if (typeof userId === 'string' && userId) balances[userId] = 0;
  }

  const receiptPayerMap = new Map<string, string | null>();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.id !== 'string' || !receipt.id) continue;
    receiptPayerMap.set(receipt.id, typeof receipt.paid_by === 'string' ? receipt.paid_by : null);
  }

  for (const split of Array.isArray(splits) ? splits : []) {
    if (!split || typeof split !== 'object') continue;
    if (typeof split.receipt_id !== 'string' || typeof split.user_id !== 'string') continue;
    if (typeof split.amount_minor !== 'number' || !Number.isFinite(split.amount_minor) || split.amount_minor <= 0) continue;
    const payerId = receiptPayerMap.get(split.receipt_id);
    if (!payerId || split.user_id === payerId) continue;

    ensureBalance(balances, payerId);
    ensureBalance(balances, split.user_id);
    balances[split.user_id] -= split.amount_minor;
    balances[payerId] += split.amount_minor;
  }

  for (const settlement of Array.isArray(settlements) ? settlements : []) {
    if (!settlement || typeof settlement !== 'object' || settlement.voided_at !== null) continue;
    if (typeof settlement.from_user_id !== 'string' || typeof settlement.to_user_id !== 'string') continue;
    if (typeof settlement.amount_minor !== 'number' || !Number.isFinite(settlement.amount_minor)) continue;

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
  /** Share-ledger status. `split` and `settled` are no longer waiting to be split. */
  status?: string | null;
};

/**
 * The only place a group is allowed to become "settled".
 * Empty groups and unsplit bills never take that path.
 * Balance math stays in `calculateNetBalances` and `simplifyDebts`.
 */
export function receiptNeedsSplit(
  receipt: { id?: string | null; status?: string | null } | null | undefined,
  splitReceiptIds?: ReadonlySet<string> | null,
): boolean {
  if (!receipt || typeof receipt !== 'object') return false;
  const id = typeof receipt.id === 'string' ? receipt.id : '';
  if (id && splitReceiptIds?.has(id)) return false;
  const status = typeof receipt.status === 'string' ? receipt.status.trim().toLowerCase() : '';
  if (status === 'split' || status === 'settled') return false;
  return true;
}

/** Badge copy for a receipt row. Unknown, empty, and missing fields stay "Unsplit". */
export function receiptProgressLabel(
  receipt: { settled_at?: unknown; status?: unknown } | null | undefined,
  hasSavedSplit?: boolean,
): 'Settled' | 'Split' | 'Unsplit' {
  if (!receipt || typeof receipt !== 'object') return hasSavedSplit === true ? 'Split' : 'Unsplit';
  const settledAt = typeof receipt.settled_at === 'string' ? receipt.settled_at.trim() : '';
  const status = typeof receipt.status === 'string' ? receipt.status.trim().toLowerCase() : '';
  if (settledAt || status === 'settled') return 'Settled';
  if (status === 'split' || hasSavedSplit === true) return 'Split';
  return 'Unsplit';
}

export function deriveGroupLedgerStatus({
  receipts,
  splits,
  settlements,
  memberIds,
  currentUserId,
}: {
  receipts: readonly GroupLedgerReceiptInput[] | null | undefined;
  splits: readonly SettlementSplitInput[] | null | undefined;
  settlements: readonly WatermarkSettlementInput[] | null | undefined;
  memberIds: readonly string[] | null | undefined;
  currentUserId: string | null | undefined;
}): GroupLedgerStatus {
  const receiptRows = (Array.isArray(receipts) ? receipts : []).filter((receipt): receipt is GroupLedgerReceiptInput => (
    Boolean(receipt) && typeof receipt === 'object' && typeof receipt.id === 'string' && receipt.id.length > 0
  ));
  const splitRows = (Array.isArray(splits) ? splits : []).filter((split): split is SettlementSplitInput => (
    Boolean(split)
    && typeof split === 'object'
    && typeof split.receipt_id === 'string'
    && typeof split.user_id === 'string'
    && typeof split.amount_minor === 'number'
    && Number.isFinite(split.amount_minor)
  ));
  const settlementRows = (Array.isArray(settlements) ? settlements : []).filter((settlement): settlement is WatermarkSettlementInput => (
    Boolean(settlement) && typeof settlement === 'object'
  ));
  const members = (Array.isArray(memberIds) ? memberIds : []).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const viewer = typeof currentUserId === 'string' && currentUserId ? currentUserId : null;

  const splitReceiptIds = new Set<string>();
  for (const split of splitRows) {
    if (split.amount_minor > 0) splitReceiptIds.add(split.receipt_id);
  }

  const lastSettledAt = latestZeroBalanceAt(receiptRows, splitRows, settlementRows);
  const { activeReceipts, settledReceipts } = partitionGroupReceipts(receiptRows, splitReceiptIds, lastSettledAt);
  const unsplitActiveCount = activeReceipts.filter((receipt) => receiptNeedsSplit(receipt, splitReceiptIds)).length;
  const netBalances = calculateNetBalances(receiptRows, splitRows, settlementRows, members);
  const simplifiedTransfers = simplifyDebts(netBalances);
  const userNetBalanceMinor = viewer ? (netBalances[viewer] ?? 0) : 0;

  let kind: GroupLedgerStatusKind;
  if (receiptRows.length === 0) {
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
    receiptCount: receiptRows.length,
    activeReceiptCount: activeReceipts.length,
    settledReceiptCount: settledReceipts.length,
    unsplitActiveCount,
    transferCount: simplifiedTransfers.length,
    userNetBalanceMinor,
  };
}

export function simplifyDebts(netBalances: Record<string, number> | null | undefined): SimplifiedTransfer[] {
  const debtors: { userId: string; amount: number }[] = [];
  const creditors: { userId: string; amount: number }[] = [];

  for (const [userId, amount] of Object.entries(netBalances ?? {})) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
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
  receipts: readonly T[] | null | undefined,
  splitReceiptIds: ReadonlySet<string> | null | undefined,
  lastSettledAt: string | null,
): PartitionedReceipts<T> {
  const activeReceipts: T[] = [];
  const settledReceipts: T[] = [];
  const settlementSource: Record<string, SettlementSource> = {};
  const watermark = typeof lastSettledAt === 'string' ? new Date(lastSettledAt).getTime() : Number.NaN;
  const knownSplits = splitReceiptIds ?? new Set<string>();

  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.id !== 'string' || !receipt.id) continue;
    const settledAt = typeof receipt.settled_at === 'string' ? receipt.settled_at.trim() : '';
    if (settledAt) {
      settledReceipts.push(receipt);
      settlementSource[receipt.id] = 'manual';
      continue;
    }

    const createdAt = typeof receipt.created_at === 'string' ? new Date(receipt.created_at).getTime() : Number.NaN;
    const automaticallySettled =
      !Number.isNaN(watermark)
      && knownSplits.has(receipt.id)
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
  receipts: readonly WatermarkReceiptInput[] | null | undefined,
  splits: readonly SettlementSplitInput[] | null | undefined,
  settlements: readonly WatermarkSettlementInput[] | null | undefined,
): string | null {
  const receiptRows = Array.isArray(receipts) ? receipts : [];
  const splitRows = Array.isArray(splits) ? splits : [];
  const settlementRows = Array.isArray(settlements) ? settlements : [];
  const splitsByReceipt = new Map<string, SettlementSplitInput[]>();
  for (const split of splitRows) {
    if (!split || typeof split !== 'object' || typeof split.receipt_id !== 'string') continue;
    const existing = splitsByReceipt.get(split.receipt_id);
    if (existing) existing.push(split);
    else splitsByReceipt.set(split.receipt_id, [split]);
  }

  const events: { at: number; order: number; kind: 'receipt' | 'settlement'; index: number }[] = [];
  receiptRows.forEach((receipt, index) => {
    if (!receipt || typeof receipt !== 'object' || typeof receipt.created_at !== 'string') return;
    const at = new Date(receipt.created_at).getTime();
    if (Number.isNaN(at)) return;
    events.push({ at, order: 0, kind: 'receipt', index });
  });
  settlementRows.forEach((settlement, index) => {
    if (!settlement || typeof settlement !== 'object' || settlement.voided_at !== null) return;
    if (typeof settlement.created_at !== 'string') return;
    const at = new Date(settlement.created_at).getTime();
    if (Number.isNaN(at)) return;
    events.push({ at, order: 1, kind: 'settlement', index });
  });
  events.sort((left, right) => left.at - right.at || left.order - right.order || left.index - right.index);

  const balances: Record<string, number> = {};
  let watermark: string | null = null;

  for (const event of events) {
    if (event.kind === 'receipt') {
      const receipt = receiptRows[event.index];
      if (!receipt) continue;
      applyReceiptSplits(balances, receipt.paid_by, splitsByReceipt.get(receipt.id) ?? []);
      continue;
    }

    const settlement = settlementRows[event.index];
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
  if (typeof paidBy !== 'string' || !paidBy) return;
  for (const split of Array.isArray(splits) ? splits : []) {
    if (!split || typeof split !== 'object' || typeof split.user_id !== 'string') continue;
    if (typeof split.amount_minor !== 'number' || !Number.isFinite(split.amount_minor) || split.amount_minor <= 0) continue;
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

/**
 * Live countdown for one shared bill.
 * `receiptTotalPence` is the scanned total and is never rewritten.
 * Host pence are deducted only once the host has confirmed, except while
 * that same host is previewing a selection that is not confirmed yet.
 * Guest pence follow each participant's paid flag. The host is never a payer.
 */
export type SplitLedgerItem = {
  id: string;
  pricePence: number;
};

export type SplitLedgerClaim = {
  itemId: string;
  participantId: string;
};

export type SplitLedgerParticipant = {
  id: string;
  isHost: boolean;
  paid: boolean;
};

export type SplitLedgerInput = {
  receiptTotalPence: number;
  items: readonly SplitLedgerItem[];
  claims: readonly SplitLedgerClaim[];
  participants: readonly SplitLedgerParticipant[];
  hostConfirmed: boolean;
  /** Local host selection. Before confirmation this drives the countdown. */
  hostPreviewItemIds?: readonly string[];
};

export type SplitLedgerState = {
  receiptTotalPence: number;
  hostConfirmedPence: number;
  hostPendingPreviewPence: number;
  guestClaimedUnpaidPence: number;
  guestPaidPence: number;
  remainingUnclaimedPence: number;
  remainingToSplitPence: number;
  remainingOwedToHostPence: number;
  isAllSettled: boolean;
  itemsClaimed: number;
  itemsTotal: number;
};

/** Co-claim pennies. Sorted ids, then one leftover penny from the front. */
export function allocateCoClaimPence(totalPence: number, participantIds: readonly string[]): Record<string, number> {
  return splitEquallyDeterministic(totalPence, participantIds);
}

export function computeSplitLedger(input: SplitLedgerInput): SplitLedgerState {
  const receiptTotalPence = Math.max(0, Math.round(input.receiptTotalPence));
  const items = dedupeItems(input.items);
  const adjusted = adjustedItemPence(items, receiptTotalPence);
  const hostIds = new Set(input.participants.filter((person) => person.isHost).map((person) => person.id));
  const primaryHost = input.participants.find((person) => person.isHost)?.id ?? null;
  const paidById = new Map(input.participants.map((person) => [person.id, person.paid]));
  const previewIds = input.hostPreviewItemIds ? uniqueIds(input.hostPreviewItemIds) : null;
  const previewing = !input.hostConfirmed && previewIds !== null && primaryHost !== null;

  const effectiveClaims = previewing && primaryHost
    ? [
        ...input.claims.filter((claim) => !hostIds.has(claim.participantId)),
        ...previewIds.map((itemId) => ({ itemId, participantId: primaryHost })),
      ]
    : input.hostConfirmed
      ? input.claims
      : input.claims.filter((claim) => !hostIds.has(claim.participantId));

  const portions = portionClaims(adjusted, effectiveClaims);
  let hostConfirmedPence = 0;
  let guestClaimedUnpaidPence = 0;
  let guestPaidPence = 0;
  for (const [participantId, amount] of portions.byParticipant) {
    if (hostIds.has(participantId)) {
      hostConfirmedPence += amount;
      continue;
    }
    if (paidById.get(participantId) === true) guestPaidPence += amount;
    else guestClaimedUnpaidPence += amount;
  }

  const hostPendingPreviewPence = pendingHostPence({
    hostConfirmed: input.hostConfirmed,
    hostConfirmedPence,
    previewIds,
    primaryHost,
    hostIds,
    claims: input.claims,
    adjusted,
  });

  const remainingUnclaimedPence = Math.max(0, receiptTotalPence - hostConfirmedPence - guestClaimedUnpaidPence - guestPaidPence);
  const remainingToSplitPence = receiptTotalPence - hostConfirmedPence - guestPaidPence;
  const remainingOwedToHostPence = Math.max(0, receiptTotalPence - hostConfirmedPence - guestPaidPence);
  const claimedItemIds = new Set(effectiveClaims.map((claim) => claim.itemId));

  return {
    receiptTotalPence,
    hostConfirmedPence,
    hostPendingPreviewPence,
    guestClaimedUnpaidPence,
    guestPaidPence,
    remainingUnclaimedPence,
    remainingToSplitPence,
    remainingOwedToHostPence,
    isAllSettled: remainingUnclaimedPence === 0 && remainingOwedToHostPence === 0,
    itemsClaimed: items.filter((item) => claimedItemIds.has(item.id)).length,
    itemsTotal: items.length,
  };
}

function pendingHostPence(input: {
  hostConfirmed: boolean;
  hostConfirmedPence: number;
  previewIds: string[] | null;
  primaryHost: string | null;
  hostIds: ReadonlySet<string>;
  claims: readonly SplitLedgerClaim[];
  adjusted: Record<string, number>;
}): number {
  if (!input.hostConfirmed) return input.hostConfirmedPence;
  if (!input.previewIds || !input.primaryHost) return 0;
  const persisted = uniqueIds(
    input.claims.filter((claim) => input.hostIds.has(claim.participantId)).map((claim) => claim.itemId),
  );
  if (sameIds(persisted, input.previewIds)) return 0;
  const hostId = input.primaryHost;
  if (!hostId) return 0;
  const previewClaims = [
    ...input.claims.filter((claim) => !input.hostIds.has(claim.participantId)),
    ...input.previewIds.map((itemId) => ({ itemId, participantId: hostId })),
  ];
  const portions = portionClaims(input.adjusted, previewClaims);
  let total = 0;
  for (const [participantId, amount] of portions.byParticipant) {
    if (input.hostIds.has(participantId)) total += amount;
  }
  return total;
}

function portionClaims(
  adjusted: Record<string, number>,
  claims: readonly SplitLedgerClaim[],
): { byParticipant: Map<string, number>; unclaimedPence: number } {
  const claimants = new Map<string, string[]>();
  for (const claim of claims) {
    if (adjusted[claim.itemId] === undefined) continue;
    const list = claimants.get(claim.itemId) ?? [];
    if (!list.includes(claim.participantId)) list.push(claim.participantId);
    claimants.set(claim.itemId, list);
  }

  const byParticipant = new Map<string, number>();
  let unclaimedPence = 0;
  for (const [itemId, pricePence] of Object.entries(adjusted)) {
    const ids = claimants.get(itemId) ?? [];
    if (ids.length === 0) {
      unclaimedPence += pricePence;
      continue;
    }
    const shares = splitEquallyDeterministic(pricePence, ids);
    for (const [participantId, amount] of Object.entries(shares)) {
      byParticipant.set(participantId, (byParticipant.get(participantId) ?? 0) + amount);
    }
  }
  return { byParticipant, unclaimedPence };
}

/** Spreads service, tip, and discounts so item totals equal the receipt. */
function adjustedItemPence(items: readonly SplitLedgerItem[], totalPence: number): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const item of items) weights[item.id] = Math.max(0, Math.round(item.pricePence));
  const lines = Object.values(weights).reduce((sum, amount) => sum + amount, 0);
  if (items.length === 0) return {};
  if (lines === totalPence) return weights;
  if (lines <= 0) return splitEquallyDeterministic(totalPence, items.map((item) => item.id));
  return allocateLargestRemainder(totalPence, weights);
}

function dedupeItems(items: readonly SplitLedgerItem[]): SplitLedgerItem[] {
  const seen = new Set<string>();
  const unique: SplitLedgerItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push({ id: item.id, pricePence: Math.max(0, Math.round(item.pricePence)) });
  }
  return unique;
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
