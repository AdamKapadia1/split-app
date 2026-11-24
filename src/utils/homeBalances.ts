/**
 * Home and group standing, in integer pence.
 * Shares that are not whole pence are ignored so a float can never enter the total.
 */

export const HOME_ATTENTION_LIMIT = 5;

export type HomeBalanceStatus = 'owed' | 'owes' | 'settled';

export type HomeBalanceShare = {
  userId: string;
  displayName: string;
  amountPence: number;
  /** Already paid. Excluded from every total and from Needs Attention. */
  settled?: boolean;
  isOnCooldown?: boolean;
};

export type HomeBalanceReceipt = {
  id: string;
  /** Receipt owner. Used as creditor only when `paidBy` is empty. */
  hostId: string;
  /** Person who paid the bill. They are the creditor when set. */
  paidBy?: string | null;
  /** Shown on a Pay row. The debtor's name lives on the share. */
  creditorName?: string | null;
  merchantName?: string | null;
  createdAt: string;
  /** Archived receipt. Every share on it is excluded. */
  settled?: boolean;
  shares: readonly HomeBalanceShare[];
};

export type AttentionItem = {
  id: string;
  type: 'nudge' | 'pay';
  receiptId: string;
  counterpartyId: string;
  counterpartyName: string;
  merchantName: string;
  amountPence: number;
  createdAt: string;
  isOnCooldown: boolean;
};

export type HomeBalances = {
  owedToYouPence: number;
  youOwePence: number;
  netPence: number;
  status: HomeBalanceStatus;
  needsAttention: AttentionItem[];
};

export type GroupNetBalance = {
  owedToYouPence: number;
  youOwePence: number;
  netPence: number;
  status: HomeBalanceStatus;
};

export type PenceParts = {
  sign: string;
  pounds: string;
  pence: string;
};

type OpenShare = {
  receiptId: string;
  creditorId: string;
  debtorId: string;
  debtorName: string;
  creditorName: string;
  merchantName: string;
  amountPence: number;
  createdAt: string;
  isOnCooldown: boolean;
};

export function computeHomeBalances(
  receipts: readonly HomeBalanceReceipt[],
  currentUserId: string | null | undefined,
): HomeBalances {
  const totals = computeGroupNetBalance(receipts, currentUserId);
  return {
    ...totals,
    needsAttention: attentionItems(receipts, currentUserId),
  };
}

export function computeGroupNetBalance(
  receipts: readonly HomeBalanceReceipt[],
  currentUserId: string | null | undefined,
): GroupNetBalance {
  const userId = currentUserId?.trim() ?? '';
  let owedToYouPence = 0;
  let youOwePence = 0;

  if (userId) {
    for (const share of openShares(receipts)) {
      if (share.creditorId === userId && share.debtorId !== userId) owedToYouPence += share.amountPence;
      else if (share.debtorId === userId && share.creditorId !== userId) youOwePence += share.amountPence;
    }
  }

  const netPence = owedToYouPence - youOwePence;
  return {
    owedToYouPence,
    youOwePence,
    netPence,
    status: balanceStatus(netPence),
  };
}

/**
 * Splits integer pence for a hero amount.
 * `pounds` is grouped (`1,000`). `pence` includes the dot (`.50`).
 * Non-integers become `0.00` instead of being rounded through a float.
 */
/**
 * True when the receipt is archived, or every saved share is already clear.
 * A receipt with no shares is still open: nobody has been given a balance yet.
 */
export function isReceiptBalanceSettled(
  receipt: Pick<HomeBalanceReceipt, 'settled' | 'hostId' | 'paidBy' | 'shares'>,
): boolean {
  if (receipt.settled) return true;
  const creditorId = receipt.paidBy?.trim() || receipt.hostId.trim();
  let comparable = false;
  for (const share of receipt.shares) {
    if (share.settled) {
      comparable = true;
      continue;
    }
    const amountPence = integerPence(share.amountPence);
    if (amountPence === null || amountPence < 0) continue;
    comparable = true;
    if (amountPence === 0) continue;
    const debtorId = share.userId.trim();
    if (debtorId && debtorId !== creditorId) return false;
  }
  return comparable;
}

export function formatPenceParts(pence: number): PenceParts {
  const minor = integerPence(pence) ?? 0;
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  return {
    sign,
    pounds: groupThousands(whole),
    pence: `.${String(fraction).padStart(2, '0')}`,
  };
}

function attentionItems(
  receipts: readonly HomeBalanceReceipt[],
  currentUserId: string | null | undefined,
): AttentionItem[] {
  const userId = currentUserId?.trim() ?? '';
  if (!userId) return [];

  const merged = new Map<string, AttentionItem>();
  for (const share of openShares(receipts)) {
    const nudge = share.creditorId === userId && share.debtorId !== userId;
    const pay = share.debtorId === userId && share.creditorId !== userId;
    if (!nudge && !pay) continue;

    const type = nudge ? 'nudge' : 'pay';
    const counterpartyId = nudge ? share.debtorId : share.creditorId;
    const id = `${share.receiptId}:${counterpartyId}:${type}`;
    const existing = merged.get(id);
    if (existing) {
      existing.amountPence += share.amountPence;
      existing.isOnCooldown = existing.isOnCooldown || share.isOnCooldown;
      continue;
    }

    merged.set(id, {
      id,
      type,
      receiptId: share.receiptId,
      counterpartyId,
      counterpartyName: nudge ? share.debtorName : share.creditorName,
      merchantName: share.merchantName,
      amountPence: share.amountPence,
      createdAt: share.createdAt,
      isOnCooldown: share.isOnCooldown,
    });
  }

  return [...merged.values()].sort(byOldestThenAmount).slice(0, HOME_ATTENTION_LIMIT);
}

function openShares(receipts: readonly HomeBalanceReceipt[]): OpenShare[] {
  const shares: OpenShare[] = [];
  for (const receipt of receipts) {
    if (receipt.settled) continue;
    const creditorId = creditorOf(receipt);
    if (!creditorId) continue;
    const merchantName = label(receipt.merchantName, 'Receipt');
    const creditorName = label(receipt.creditorName, 'Someone');

    for (const share of receipt.shares) {
      if (share.settled) continue;
      const amountPence = integerPence(share.amountPence);
      if (amountPence === null || amountPence <= 0) continue;
      const debtorId = share.userId.trim();
      if (!debtorId || debtorId === creditorId) continue;
      shares.push({
        receiptId: receipt.id,
        creditorId,
        debtorId,
        debtorName: label(share.displayName, 'Someone'),
        creditorName,
        merchantName,
        amountPence,
        createdAt: receipt.createdAt,
        isOnCooldown: share.isOnCooldown === true,
      });
    }
  }
  return shares;
}

function creditorOf(receipt: HomeBalanceReceipt): string {
  const paidBy = receipt.paidBy?.trim() ?? '';
  if (paidBy) return paidBy;
  return receipt.hostId.trim();
}

function balanceStatus(netPence: number): HomeBalanceStatus {
  if (netPence > 0) return 'owed';
  if (netPence < 0) return 'owes';
  return 'settled';
}

function byOldestThenAmount(left: AttentionItem, right: AttentionItem): number {
  const leftTime = timeOf(left.createdAt);
  const rightTime = timeOf(right.createdAt);
  if (leftTime !== rightTime) return leftTime - rightTime;
  if (left.amountPence !== right.amountPence) return right.amountPence - left.amountPence;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function timeOf(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function integerPence(value: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value;
}

function label(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? '';
  return trimmed || fallback;
}

function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
