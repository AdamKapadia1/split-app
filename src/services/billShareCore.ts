/**
 * Pure, platform-free parts of BillShareService: the error type, the safe
 * error mapper, the single bounded retry for read-only RPCs, and the response
 * parsers. Kept out of BillShareService.ts so Node tests can load it without
 * the React Native Supabase client.
 */

import { isHostParticipant, publicHostLabel } from '@/utils/hostAttribution';
import { mapErrorToUserMessage, readSafeErrorCode } from '@/utils/errorMapper';
import { logger } from '@/utils/logger';

import type {
  HostClaimState,
  SharePayoutDetails,
  SharedBill,
  SharedBillItem,
  SharedClaimant,
  SharedParticipant,
} from './BillShareService';

export type BillShareCode = 'NOT_CONFIGURED' | 'UNAUTHORIZED' | 'INVALID' | 'NOT_FOUND' | 'FAILED';

export class BillShareServiceError extends Error {
  readonly code: BillShareCode;

  constructor(code: BillShareCode, message: string) {
    super(message);
    this.name = 'BillShareServiceError';
    this.code = code;
  }
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asShareError(error: unknown, fallbackCode: BillShareCode, fallback: string): BillShareServiceError {
  if (error instanceof BillShareServiceError) return error;
  const sql = readSafeErrorCode(error, '');
  logger.error('BillShareService', { code: sql || fallbackCode });
  if (sql === '42501' || sql === '28000' || sql === 'PGRST301') {
    return new BillShareServiceError('UNAUTHORIZED', mapErrorToUserMessage(error, 'You cannot change this share link.'));
  }
  if (sql === '22023') {
    return new BillShareServiceError('INVALID', 'This split link is expired or has been turned off by the host.');
  }
  return new BillShareServiceError(fallbackCode, mapErrorToUserMessage(error, fallback));
}

/** Delay before the single retry of a read-only RPC. */
export const READ_RETRY_DELAY_MS = 400;

/** The parts of a supabase-js response the retry needs. `status` is 0 when the request never completed. */
export type ReadRpcResponse = {
  data: unknown;
  error: unknown;
  status?: number;
};

export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/**
 * True only for a transport or lifecycle drop: offline or DNS blips, aborted
 * cold-start connections, and gateway pages (502/503/504) that carry no
 * database code. Anything with a whitelisted SQL/PostgREST code (auth, RLS,
 * invalid token), any 4xx, and any BillShareServiceError (parser failures)
 * is a real answer and is never retried.
 */
export function isTransientReadFailure(error: unknown, status?: number): boolean {
  if (error instanceof BillShareServiceError) return false;
  if (readSafeErrorCode(error, '') !== '') return false;
  const httpStatus = typeof status === 'number' ? status : statusOf(error);
  if (httpStatus >= 400 && httpStatus <= 499) return false;
  return true;
}

/**
 * Runs a READ-ONLY RPC, retrying at most once after READ_RETRY_DELAY_MS when
 * the first failure is transient. Returns the response data, or throws the
 * last raw error so the caller maps and logs it exactly once.
 *
 * Never use this for a mutating RPC: a dropped response does not prove the
 * write did not happen.
 */
export async function readRpcWithRetry(
  call: () => PromiseLike<ReadRpcResponse>,
  sleep: Sleep = defaultSleep,
): Promise<unknown> {
  const first = await attempt(call);
  if (first.ok) return first.data;
  if (!isTransientReadFailure(first.error, first.status)) throw first.error;
  await sleep(READ_RETRY_DELAY_MS);
  const second = await attempt(call);
  if (second.ok) return second.data;
  throw second.error;
}

/**
 * The full read path shared by fetchSharedBill and fetchHostClaims: bounded
 * retry, null for "no such bill", parse, then one safe mapping. Parser errors
 * happen after the retry, so a malformed 200 response is never retried.
 * asShareError (and therefore logger.error / Sentry) runs only when the final
 * attempt fails.
 */
export async function runReadRpc<T>(
  call: () => PromiseLike<ReadRpcResponse>,
  parse: (data: unknown) => T,
  fallback: string,
  sleep?: Sleep,
): Promise<T | null> {
  try {
    const data = await readRpcWithRetry(call, sleep);
    if (data == null) return null;
    return parse(data);
  } catch (error) {
    throw asShareError(error, 'FAILED', fallback);
  }
}

type Attempt = { ok: true; data: unknown } | { ok: false; error: unknown; status?: number };

async function attempt(call: () => PromiseLike<ReadRpcResponse>): Promise<Attempt> {
  try {
    const response = await call();
    if (response.error) return { ok: false, error: response.error, status: response.status };
    return { ok: true, data: response.data };
  } catch (error) {
    return { ok: false, error };
  }
}

function statusOf(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : 0;
}

export function parseSharedBill(value: unknown): SharedBill {
  const row = asRecord(value);
  const bill = asRecord(row?.bill);
  const owner = asRecord(row?.owner);
  if (!bill || typeof bill.id !== 'string' || !owner) {
    throw new BillShareServiceError('FAILED', 'Could not load this split.');
  }

  return {
    bill: {
      id: bill.id,
      merchantName: text(bill.merchant_name, 'Receipt'),
      billDate: text(bill.bill_date, text(bill.created_at, '')),
      currency: text(bill.currency, 'GBP'),
      subtotalPence: pence(bill.subtotal_pence),
      vatAmount: money(bill.vat_amount),
      vatPence: pence(bill.vat_pence),
      serviceChargeAmount: money(bill.service_charge_amount),
      serviceChargePence: pence(bill.service_charge_pence),
      serviceChargeRate: bill.service_charge_rate == null ? null : money(bill.service_charge_rate),
      totalAmount: money(bill.total_amount),
      totalPence: pence(bill.total_pence),
      isReconciled: bill.is_reconciled === true,
      createdAt: text(bill.created_at, text(bill.bill_date, '')),
      hostConfirmedAt: typeof bill.host_confirmed_at === 'string' ? bill.host_confirmed_at : null,
      viewerIsHost: bill.viewer_is_host === true,
    },
    owner: {
      displayName: publicHostLabel(text(owner.host_display_name, text(owner.display_name, 'Host'))),
      payoutDetails: parsePayout(owner.payout_details),
    },
    items: Array.isArray(row?.items) ? row.items.map(parseItem) : [],
    participants: Array.isArray(row?.participants) ? row.participants.map(parseParticipant) : [],
  };
}

function parseItem(value: unknown): SharedBillItem {
  const row = asRecord(value);
  if (!row || typeof row.id !== 'string') {
    throw new BillShareServiceError('FAILED', 'Could not load this split.');
  }
  const quantity = pence(row.quantity);
  return {
    id: row.id,
    name: text(row.name, 'Item'),
    quantity: quantity > 0 ? quantity : 1,
    unitPricePence: pence(row.unit_price_pence),
    totalPricePence: pence(row.total_price_pence),
    claimedBy: Array.isArray(row.claimed_by) ? row.claimed_by.map(parseClaimant) : [],
  };
}

function parseClaimant(value: unknown): SharedClaimant {
  const row = asRecord(value);
  if (!row || typeof row.id !== 'string') {
    throw new BillShareServiceError('FAILED', 'Could not load this split.');
  }
  const displayName = text(row.display_name, 'Guest');
  return {
    id: row.id,
    displayName,
    userId: typeof row.user_id === 'string' ? row.user_id : null,
    isHost: parseIsHost(row, displayName),
  };
}

function parseParticipant(value: unknown): SharedParticipant {
  const row = asRecord(value);
  if (!row || typeof row.id !== 'string') {
    throw new BillShareServiceError('FAILED', 'Could not load this split.');
  }
  const displayName = text(row.display_name, 'Guest');
  const isHost = parseIsHost(row, displayName);
  return {
    id: row.id,
    displayName: isHost ? publicHostLabel(displayName) : displayName,
    userId: typeof row.user_id === 'string' ? row.user_id : null,
    amountOwedPence: pence(row.amount_owed_pence),
    itemsSubtotalPence: pence(row.items_subtotal_pence),
    serviceChargePence: pence(row.service_charge_pence),
    isPaid: isHost || row.is_paid === true,
    paidAt: typeof row.paid_at === 'string' ? row.paid_at : null,
    isGuest: row.is_guest === true,
    isHost,
  };
}

export function parseHostClaimState(value: unknown): HostClaimState {
  const row = asRecord(value);
  if (!row || !Array.isArray(row.claimed_item_ids)) {
    throw new BillShareServiceError('FAILED', 'Could not load your items.');
  }
  const claimedItemIds = row.claimed_item_ids.filter((itemId): itemId is string => typeof itemId === 'string' && UUID_PATTERN.test(itemId));
  return {
    hostDisplayName: publicHostLabel(row.host_display_name),
    claimedItemIds,
    amountOwedPence: pence(row.amount_owed_pence),
    unclaimedPence: pence(row.unclaimed_pence),
    itemsClaimed: pence(row.items_claimed),
    itemsTotal: pence(row.items_total),
    hostConfirmedAt: typeof row.host_confirmed_at === 'string' ? row.host_confirmed_at : null,
  };
}

function parseIsHost(row: Record<string, unknown>, displayName: string): boolean {
  if (typeof row.is_host === 'boolean') return row.is_host;
  return isHostParticipant({
    isGuest: row.is_guest === true,
    userId: typeof row.user_id === 'string' ? row.user_id : null,
    displayName,
  });
}

function parsePayout(value: unknown): SharePayoutDetails | null {
  const row = asRecord(value);
  if (!row) return null;
  const preferred = row.preferred_method;
  return {
    preferredMethod: preferred === 'monzo' || preferred === 'revolut' || preferred === 'paypal' || preferred === 'bank' ? preferred : null,
    monzoHandle: textOrNull(row.monzo_handle),
    revolutHandle: textOrNull(row.revolut_handle),
    paypalHandle: textOrNull(row.paypal_handle),
    bankAccountName: textOrNull(row.bank_account_name),
    bankSortCode: textOrNull(row.bank_sort_code),
    bankAccountNumber: textOrNull(row.bank_account_number),
    paymentLink: textOrNull(row.payment_link),
  };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function money(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(numeric) ? numeric : 0;
}

function pence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric);
}
