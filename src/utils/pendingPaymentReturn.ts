export const PENDING_PAYMENT_TTL_MS = 30 * 60 * 1000;

export const CONFIRM_RETRY_MESSAGE = 'Could not confirm that payment. Check the connection and try again.';

export type PendingPaymentProvider = 'Monzo' | 'Revolut' | 'Bank';

export type PendingPaymentRecord = {
  provider: PendingPaymentProvider;
  shareToken: string;
  guestId: string;
  amountPence: number;
  amountFormatted: string;
  startedAt: number;
};

const PROVIDERS = new Set<PendingPaymentProvider>(['Monzo', 'Revolut', 'Bank']);
const AMOUNT_LABEL = /^\d+\.\d{2}$/;
const memory = new Map<string, string>();
let forceMemory = false;

export function resetPendingPaymentStorageForTests(): void {
  memory.clear();
  forceMemory = false;
}

export const safeSessionStorage = {
  getItem(key: string): string | null {
    const store = browserSession();
    if (!store) return memory.get(key) ?? null;
    try {
      return store.getItem(key);
    } catch {
      forceMemory = true;
      return memory.get(key) ?? null;
    }
  },
  setItem(key: string, value: string): void {
    memory.set(key, value);
    const store = browserSession();
    if (!store) return;
    try {
      store.setItem(key, value);
    } catch {
      forceMemory = true;
    }
  },
  removeItem(key: string): void {
    memory.delete(key);
    const store = browserSession();
    if (!store) return;
    try {
      store.removeItem(key);
    } catch {
      forceMemory = true;
    }
  },
};

export function pendingPaymentStorageKey(shareToken: string, guestId: string): string {
  return `velor:pending-payment:${shareToken}:${guestId}`;
}

export function formatPendingAmount(pence: number): string {
  const minor = Number.isFinite(pence) ? Math.max(0, Math.trunc(pence)) : 0;
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

export function readPendingPayment(shareToken: string, guestId: string, now = Date.now()): PendingPaymentRecord | null {
  const key = pendingPaymentStorageKey(shareToken, guestId);
  const raw = safeSessionStorage.getItem(key);
  if (!raw) return null;
  const parsed = parsePending(raw, shareToken, guestId, now);
  if (!parsed) {
    safeSessionStorage.removeItem(key);
    return null;
  }
  return parsed;
}

export function recordPendingPayment(input: {
  provider: PendingPaymentProvider;
  shareToken: string;
  guestId: string;
  amountPence: number;
}): PendingPaymentRecord {
  const next: PendingPaymentRecord = {
    provider: input.provider,
    shareToken: input.shareToken,
    guestId: input.guestId,
    amountPence: Number.isFinite(input.amountPence) ? Math.max(0, Math.trunc(input.amountPence)) : 0,
    amountFormatted: formatPendingAmount(input.amountPence),
    startedAt: Date.now(),
  };
  writePendingPayment(next);
  return next;
}

export function writePendingPayment(record: PendingPaymentRecord): void {
  if (!isLiveRecord(record, record.shareToken, record.guestId, record.startedAt)) return;
  safeSessionStorage.setItem(pendingPaymentStorageKey(record.shareToken, record.guestId), JSON.stringify(record));
}

export function clearPendingPayment(shareToken: string, guestId: string): void {
  safeSessionStorage.removeItem(pendingPaymentStorageKey(shareToken, guestId));
}

export function planReturnToTab(
  pending: PendingPaymentRecord | null,
  shareIsPaid: boolean,
  now = Date.now(),
): { pending: PendingPaymentRecord | null; showPrompt: boolean } {
  if (!pending || !isLiveRecord(pending, pending.shareToken, pending.guestId, now)) {
    return { pending: null, showPrompt: false };
  }
  if (shareIsPaid) return { pending: null, showPrompt: false };
  return { pending, showPrompt: true };
}

export function reconcilePendingPayment(input: {
  shareToken: string;
  guestId: string;
  shareIsPaid: boolean;
  now?: number;
}): { pending: PendingPaymentRecord | null; showPrompt: boolean } {
  const now = input.now ?? Date.now();
  const stored = readPendingPayment(input.shareToken, input.guestId, now);
  const decision = planReturnToTab(stored, input.shareIsPaid, now);
  if (!decision.pending) clearPendingPayment(input.shareToken, input.guestId);
  return decision;
}

export function tryBeginConfirm(lock: { current: boolean }): boolean {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function endConfirm(lock: { current: boolean }): void {
  lock.current = false;
}

export type LockRef = { current: boolean };

/**
 * Takes every lock in `acquire` only when all of them, and every lock in
 * `mustBeFree`, are currently free. Returns a release function, or null when
 * anything is held. The release clears only the locks this call took, and
 * only once, so a second caller can never unlock work it does not own.
 */
export function tryAcquireLocks(acquire: readonly LockRef[], mustBeFree: readonly LockRef[] = []): (() => void) | null {
  if (acquire.some((lock) => lock.current) || mustBeFree.some((lock) => lock.current)) return null;
  for (const lock of acquire) lock.current = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const lock of acquire) lock.current = false;
  };
}

export function withPaidFlag<T extends { id: string; isPaid: boolean; paidAt: string | null }>(
  rows: readonly T[],
  participantId: string,
  isPaid: boolean,
  paidAt: string | null,
): T[] {
  return rows.map((row) => (row.id === participantId ? { ...row, isPaid, paidAt } : row));
}

export function confirmationFailure<T>(previousBill: T, pending: PendingPaymentRecord): {
  bill: T;
  pending: PendingPaymentRecord;
  error: string;
} {
  return { bill: previousBill, pending, error: CONFIRM_RETRY_MESSAGE };
}

function browserSession(): Storage | null {
  if (forceMemory) return null;
  if (typeof window === 'undefined') return null;
  try {
    const store = window.sessionStorage;
    if (!store || typeof store.getItem !== 'function') return null;
    return store;
  } catch {
    forceMemory = true;
    return null;
  }
}

function parsePending(raw: string, shareToken: string, guestId: string, now: number): PendingPaymentRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isLiveRecord(value, shareToken, guestId, now)) return null;
    return value;
  } catch {
    return null;
  }
}

function isLiveRecord(value: unknown, shareToken: string, guestId: string, now: number): value is PendingPaymentRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== 'string' || !PROVIDERS.has(record.provider as PendingPaymentProvider)) return false;
  if (record.shareToken !== shareToken || typeof shareToken !== 'string' || shareToken.length < 20) return false;
  if (record.guestId !== guestId || typeof guestId !== 'string' || guestId.length === 0) return false;
  if (typeof record.amountPence !== 'number' || !Number.isSafeInteger(record.amountPence) || record.amountPence < 0) return false;
  if (typeof record.amountFormatted !== 'string' || !AMOUNT_LABEL.test(record.amountFormatted)) return false;
  if (typeof record.startedAt !== 'number' || !Number.isFinite(record.startedAt)) return false;
  if (now - record.startedAt > PENDING_PAYMENT_TTL_MS) return false;
  return true;
}
