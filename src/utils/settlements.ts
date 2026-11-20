/**
 * Integer-pence settlement math.
 * Positive balance means the person is owed money. Negative means they owe money.
 * Every debit has a matching credit, so a group's balances always sum to zero.
 */

export type SettlementReceiptInput = {
  id: string;
  paid_by: string | null;
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
  receipts: SettlementReceiptInput[],
  splits: SettlementSplitInput[],
  settlements: SettlementRecordInput[],
  memberIds: string[],
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
