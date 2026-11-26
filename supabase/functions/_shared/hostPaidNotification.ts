/** Guest shares live on receipt_share_participants.is_paid, not a text status. */
export const SHARE_PARTICIPANTS_TABLE = 'receipt_share_participants';

const RECEIPT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Host bill screen. Expo Router file: src/app/receipt/[id].tsx */
export const PAYMENT_ROUTE_PATTERN = /^\/receipt\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PAYMENT_RECEIVED_TITLE = 'Payment received';

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export type SharePaidSnapshot = {
  is_paid?: unknown;
  is_host?: unknown;
  host_confirmed_at?: unknown;
  id?: unknown;
  receipt_id?: unknown;
  user_id?: unknown;
  display_name?: unknown;
  amount_owed_pence?: unknown;
};

export type HostPaidDecision =
  | { action: 'ignore' }
  | {
      action: 'notify';
      shareId: string;
      receiptId: string;
      payerUserId: string | null;
      guestName: string;
      amountPence: number;
    };

export function isSharePaidTransition(input: {
  type: unknown;
  table: unknown;
  record: SharePaidSnapshot | null;
  oldRecord: SharePaidSnapshot | null;
}): boolean {
  if (input.type !== 'UPDATE') return false;
  if (input.table !== SHARE_PARTICIPANTS_TABLE) return false;
  if (!input.record || !input.oldRecord) return false;
  return input.oldRecord.is_paid !== true && input.record.is_paid === true;
}

/**
 * Host confirmation writes `host_confirmed_at` and item claims.
 * Those rows must never become a payment push. A guest unpaid-to-paid
 * update on receipt_share_participants is the only notify path.
 */
export function shouldIgnoreHostPaidWebhook(input: {
  type: unknown;
  table: unknown;
  record: SharePaidSnapshot | null;
  oldRecord: SharePaidSnapshot | null;
}): boolean {
  if (input.table !== SHARE_PARTICIPANTS_TABLE) return true;
  if (input.record?.is_host === true || input.oldRecord?.is_host === true) return true;
  return !isSharePaidTransition(input);
}

/**
 * Paid transition on a guest share. A host row never notifies the host.
 * `is_host` wins even when the user id is missing or points at someone else.
 * Amounts are integer pence on amount_owed_pence.
 */
export function decideHostPaidNotification(
  input: {
    type: unknown;
    table: unknown;
    record: SharePaidSnapshot | null;
    oldRecord: SharePaidSnapshot | null;
  },
  hostUserId: string | null,
): HostPaidDecision {
  if (!isSharePaidTransition(input) || !input.record) return { action: 'ignore' };
  if (input.record.is_host === true || input.oldRecord?.is_host === true) return { action: 'ignore' };

  const shareId = readUuid(input.record.id);
  const receiptId = readUuid(input.record.receipt_id);
  if (!shareId || !receiptId) return { action: 'ignore' };

  const payerUserId = readUuid(input.record.user_id);
  const previousUserId = readUuid(input.oldRecord?.user_id);
  if (hostUserId && (payerUserId === hostUserId || previousUserId === hostUserId)) return { action: 'ignore' };

  return {
    action: 'notify',
    shareId,
    receiptId,
    payerUserId,
    guestName: lockScreenGuestName(input.record.display_name),
    amountPence: readPence(input.record.amount_owed_pence),
  };
}

export function isAllowedPaymentRoute(route: unknown): route is string {
  return typeof route === 'string' && PAYMENT_ROUTE_PATTERN.test(route);
}

export function paymentRouteForReceipt(receiptId: string): string | null {
  if (!isUuid(receiptId)) return null;
  const route = `/receipt/${receiptId.toLowerCase()}`;
  return isAllowedPaymentRoute(route) ? route : null;
}

/** Drop any notification route that is not this app's bill screen. */
export function receiptIdFromPaymentData(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as { route?: unknown; billId?: unknown };
  if (!isAllowedPaymentRoute(record.route)) return null;
  const receiptId = record.route.slice('/receipt/'.length).toLowerCase();
  if (!isUuid(receiptId)) return null;
  if (typeof record.billId === 'string' && record.billId.toLowerCase() !== receiptId) return null;
  return receiptId;
}

export function formatGbpFromPence(amountPence: number): string {
  const minor = Number.isFinite(amountPence) ? Math.trunc(amountPence) : 0;
  const pounds = Math.max(0, minor) / 100;
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(pounds);
}

export function formatSharePaidNotification(input: {
  guestName: string;
  amountPence: number;
  venue: unknown;
  receiptId: string;
  shareId: string;
}): { title: string; body: string; data: { route: string; billId: string; shareId: string } } | null {
  const route = paymentRouteForReceipt(input.receiptId);
  if (!route || !isUuid(input.shareId)) return null;
  const venue = lockScreenMerchantName(input.venue);
  return {
    title: PAYMENT_RECEIVED_TITLE,
    body: `${lockScreenGuestName(input.guestName)} marked ${formatGbpFromPence(input.amountPence)} as paid for ${venue}`,
    data: {
      route,
      billId: input.receiptId.toLowerCase(),
      shareId: input.shareId.toLowerCase(),
    },
  };
}

/** Lock-screen merchant text. Sort codes and account numbers are stripped. */
export function lockScreenMerchantName(value: unknown) {
  if (typeof value !== 'string') return 'your receipt';
  const cleaned = value
    .replace(/\b\d{2}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{6,8}\b/g, '')
    .replace(/[^\p{L}\p{N}&'., -]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned || 'your receipt';
}

export function lockScreenGuestName(value: unknown): string {
  if (typeof value !== 'string') return 'Someone';
  const cleaned = value
    .replace(CONTROL_CHARS, '')
    .replace(/\b\d{2}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{6,8}\b/g, '')
    .replace(/[^\p{L}\p{N}&'., -]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  if (!cleaned || cleaned.includes('@')) return 'Someone';
  return cleaned;
}

export function readPence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? Math.max(0, parsed) : 0;
  }
  return 0;
}

function readUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return isUuid(trimmed) ? trimmed : null;
}

function isUuid(value: string): boolean {
  return RECEIPT_UUID_PATTERN.test(value);
}
