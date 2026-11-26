/**
 * Public host name and settlement rules for a shared bill.
 * Guests only ever see a display name. Email, phone, and bank numbers are dropped.
 * The person who paid the bill is never asked to pay themselves.
 */

import { reconcileSharedBill } from '@/utils/sharedSplitMath';

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;
const GENERATED_HANDLE = /^[A-Za-z]{1,8}[0-9]{2,8}$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SORT_CODE = /\b\d{2}-\d{2}-\d{2}\b/;
const LONG_DIGITS = /\d{6,}/;

export type HostIdentity = {
  isHost?: boolean;
  isGuest?: boolean;
  userId?: string | null;
  displayName?: string | null;
};

export type HostNameInput = {
  firstName?: string | null;
  fullName?: string | null;
  storedName?: string | null;
};

export type OwedShare = {
  userId: string;
  amountPence: number;
  isHost?: boolean;
  settled?: boolean;
};

/**
 * Profile first name, then full name, then a stored participant label.
 * "Host" is the only fallback, and only when nothing public is set.
 */
export function resolveHostDisplayName(input: HostNameInput): string {
  const first = publicName(input.firstName);
  if (first) return first;
  const full = publicName(input.fullName);
  if (full) return full;
  const stored = publicName(input.storedName);
  if (stored && stored.toLowerCase() !== 'host') return stored;
  return 'Host';
}

/** Last line of defence for a name already returned to the guest page. */
export function publicHostLabel(value: unknown): string {
  return publicName(typeof value === 'string' ? value : null) ?? 'Host';
}

export function hostPayerPillLabel(hostName: string): string {
  return `${publicHostLabel(hostName)} · Paid`;
}

export function payerAttributionLine(hostName: string): string {
  return `Paid outright by ${publicHostLabel(hostName)}`;
}

export function whoAreYouPrompt(hostName: string): string {
  const name = publicHostLabel(hostName);
  return `Tap your name (or add yourself) and select what you had to see what you owe ${name}.`;
}

export function selectNamePrompt(hostName: string): string {
  const name = publicHostLabel(hostName);
  return `Select your name to see what you owe ${name}.`;
}

export function hostSettledShareCopy(amountLabel: string): { title: string; subtitle: string } {
  return {
    title: `Your share: ${amountLabel} · Paid outright`,
    subtitle: 'You paid the full bill — your share is already settled.',
  };
}

export type HostConfirmMode = 'confirm' | 'confirm-none' | 'update' | 'settled';

/** Primary action for the host's own items. Settled means the button stays hidden. */
export function hostConfirmMode(input: { confirmed: boolean; selectedCount: number; dirty: boolean }): HostConfirmMode {
  if (!input.confirmed) return input.selectedCount === 0 ? 'confirm-none' : 'confirm';
  if (input.dirty) return 'update';
  return 'settled';
}

export function hostConfirmActionLabel(amountLabel: string, mode: HostConfirmMode): string {
  if (mode === 'confirm-none') return 'Confirm no items (£0.00)';
  if (mode === 'update') return `Update my items (${amountLabel})`;
  if (mode === 'confirm') return `Confirm my items (${amountLabel})`;
  return `Your share: ${amountLabel} · Deducted`;
}

export function hostDeductedShareCopy(amountLabel: string): { title: string; subtitle: string } {
  return {
    title: `Your share: ${amountLabel} · Deducted`,
    subtitle: 'Paid outright by you — deducted from the group split.',
  };
}

/**
 * Host row from `is_host`, else the receipt owner id, else a legacy
 * non-guest participant still labelled "Host".
 */
export function isHostParticipant(person: HostIdentity, hostUserId?: string | null): boolean {
  if (person.isHost === true) return true;
  if (person.isHost === false) return false;
  const userId = person.userId?.trim() ?? '';
  const hostId = hostUserId?.trim() ?? '';
  if (userId && hostId && userId === hostId) return true;
  if (person.isGuest === true) return false;
  return (person.displayName ?? '').trim() === 'Host';
}

export function canMarkSharePaid(person: HostIdentity, hostUserId?: string | null): boolean {
  return !isHostParticipant(person, hostUserId);
}

/**
 * Money other people still owe the payer.
 * The payer's own claimed share is omitted, whether or not it is flagged `isHost`.
 */
export function outstandingOwedToHostPence(shares: readonly OwedShare[], payerUserId: string): number {
  const payer = payerUserId.trim();
  let total = 0;
  for (const share of shares) {
    if (share.settled === true || share.isHost === true) continue;
    const debtor = share.userId.trim();
    if (!debtor || (payer && debtor === payer)) continue;
    if (!Number.isSafeInteger(share.amountPence) || share.amountPence <= 0) continue;
    total += share.amountPence;
  }
  return total;
}

export function hostClaimProgress(input: {
  items: readonly { id: string; pricePence: number }[];
  hostId: string;
  claims: readonly { itemId: string; participantId: string }[];
  participantIds: readonly string[];
  totalPence: number;
  serviceChargePence: number;
}): {
  itemsClaimed: number;
  itemsTotal: number;
  unclaimedPence: number;
  hostOwedPence: number;
} {
  const math = reconcileSharedBill({
    items: input.items,
    claims: input.claims,
    participantIds: input.participantIds,
    totalPence: input.totalPence,
    serviceChargePence: input.serviceChargePence,
  });
  const claimedItems = new Set(input.claims.map((claim) => claim.itemId));
  return {
    itemsClaimed: input.items.filter((item) => claimedItems.has(item.id)).length,
    itemsTotal: input.items.length,
    unclaimedPence: math.unclaimedPence,
    hostOwedPence: math.amountOwed[input.hostId] ?? 0,
  };
}

function publicName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!cleaned) return null;
  if (cleaned.includes('@')) return null;
  if (UUID_TEXT.test(cleaned) || GENERATED_HANDLE.test(cleaned)) return null;
  if (SORT_CODE.test(cleaned) || LONG_DIGITS.test(cleaned)) return null;
  return cleaned;
}
