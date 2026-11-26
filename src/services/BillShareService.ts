import { getWebBaseUrl } from '@/lib/url';
import { supabase } from '@/lib/supabase';
import { isHostParticipant, publicHostLabel } from '@/utils/hostAttribution';
import { mapErrorToUserMessage, readSafeErrorCode } from '@/utils/errorMapper';
import { logger } from '@/utils/logger';

export type SharePayoutDetails = {
  preferredMethod: 'monzo' | 'revolut' | 'paypal' | 'bank' | null;
  monzoHandle: string | null;
  revolutHandle: string | null;
  paypalHandle: string | null;
  bankAccountName: string | null;
  bankSortCode: string | null;
  bankAccountNumber: string | null;
  paymentLink: string | null;
};

export type SharedClaimant = {
  id: string;
  displayName: string;
  userId: string | null;
  isHost: boolean;
};

export type SharedBillItem = {
  id: string;
  name: string;
  quantity: number;
  unitPricePence: number;
  totalPricePence: number;
  claimedBy: SharedClaimant[];
};

export type SharedParticipant = {
  id: string;
  displayName: string;
  userId: string | null;
  amountOwedPence: number;
  itemsSubtotalPence: number;
  serviceChargePence: number;
  isPaid: boolean;
  paidAt: string | null;
  isGuest: boolean;
  isHost: boolean;
};

export type HostClaimState = {
  hostDisplayName: string;
  claimedItemIds: string[];
  amountOwedPence: number;
  unclaimedPence: number;
  itemsClaimed: number;
  itemsTotal: number;
};

export type SharedBill = {
  bill: {
    id: string;
    merchantName: string;
    billDate: string;
    currency: string;
    subtotalPence: number;
    vatAmount: number;
    vatPence: number;
    serviceChargeAmount: number;
    serviceChargePence: number;
    serviceChargeRate: number | null;
    totalAmount: number;
    totalPence: number;
    isReconciled: boolean;
    createdAt: string;
  };
  owner: {
    displayName: string;
    payoutDetails: SharePayoutDetails | null;
  };
  items: SharedBillItem[];
  participants: SharedParticipant[];
};

export type BillShareStatus = {
  shareToken: string | null;
  shareEnabled: boolean;
};

export type SharedBillAction = 'toggle_item_claim' | 'set_paid_status';

export type BillShareCode = 'NOT_CONFIGURED' | 'UNAUTHORIZED' | 'INVALID' | 'NOT_FOUND' | 'FAILED';

export class BillShareServiceError extends Error {
  readonly code: BillShareCode;

  constructor(code: BillShareCode, message: string) {
    super(message);
    this.name = 'BillShareServiceError';
    this.code = code;
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BillShareService {
  async enableBillShare(billId: string): Promise<{ shareToken: string; shareEnabled: true }> {
    const id = requireId(billId);
    try {
      const client = requireClient();
      const { data, error } = await client.rpc('enable_bill_share', { p_bill_id: id });
      if (error) throw error;
      const row = asRecord(data);
      const shareToken = typeof row?.share_token === 'string' ? row.share_token : '';
      if (!TOKEN_PATTERN.test(shareToken) || row?.share_enabled !== true) {
        throw new BillShareServiceError('FAILED', 'Could not create the share link.');
      }
      return { shareToken, shareEnabled: true };
    } catch (error) {
      throw asShareError(error, 'FAILED', 'Could not create the share link.');
    }
  }

  async revokeBillShare(billId: string): Promise<void> {
    const id = requireId(billId);
    try {
      const client = requireClient();
      const { error } = await client.rpc('revoke_bill_share', { p_bill_id: id });
      if (error) throw error;
    } catch (error) {
      throw asShareError(error, 'FAILED', 'Could not turn off the share link.');
    }
  }

  async getShareStatus(billId: string): Promise<BillShareStatus> {
    const id = requireId(billId);
    try {
      const client = requireClient();
      const { data, error } = await client
        .from('receipts')
        .select('share_token, share_enabled')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      const row = asRecord(data);
      const shareToken = typeof row?.share_token === 'string' && TOKEN_PATTERN.test(row.share_token) ? row.share_token : null;
      return {
        shareToken,
        shareEnabled: row?.share_enabled === true && shareToken !== null,
      };
    } catch (error) {
      throw asShareError(error, 'FAILED', 'Could not load the share link.');
    }
  }

  async fetchSharedBill(token: string): Promise<SharedBill | null> {
    const shareToken = requireToken(token);
    try {
      const client = requireClient();
      const { data, error } = await client.rpc('get_shared_bill', { p_share_token: shareToken });
      if (error) throw error;
      if (data == null) return null;
      return parseSharedBill(data);
    } catch (error) {
      throw asShareError(error, 'FAILED', 'Could not load this split.');
    }
  }

  async mutateSharedBill(token: string, action: SharedBillAction, payload: Record<string, unknown>): Promise<SharedBill | null> {
    const shareToken = requireToken(token);
    try {
      const client = requireClient();
      const { data, error } = await client.rpc('update_shared_bill_claim', {
        p_share_token: shareToken,
        p_action: action,
        p_payload: payload,
      });
      if (error) throw error;
      if (data == null) return null;
      return parseSharedBill(data);
    } catch (error) {
      throw asShareError(error, 'FAILED', 'Could not update this split.');
    }
  }

  async fetchHostClaims(receiptId: string): Promise<HostClaimState | null> {
    const id = requireUuid(receiptId);
    try {
      const client = requireClient();
      const { data, error } = await client.rpc('get_host_claim_state', { p_receipt_id: id });
      if (error) throw error;
      if (data == null) return null;
      return parseHostClaimState(data);
    } catch (error) {
      throw asShareError(error, 'FAILED', 'Could not load your items.');
    }
  }

  async setHostClaims(receiptId: string, itemIds: readonly string[]): Promise<HostClaimState | null> {
    const id = requireUuid(receiptId);
    const claimed = itemIds.map((itemId) => requireUuid(itemId));
    try {
      const client = requireClient();
      const { data, error } = await client.rpc('set_host_item_claims', {
        p_receipt_id: id,
        p_item_ids: claimed,
      });
      if (error) throw error;
      if (data == null) return null;
      return parseHostClaimState(data);
    } catch (error) {
      throw asShareError(error, 'FAILED', 'Could not update your items.');
    }
  }
}

export const billShareService = new BillShareService();

export function shareBillUrl(token: string): string {
  return `${getWebBaseUrl()}/s/${token}`;
}

function requireClient() {
  if (!supabase) throw new BillShareServiceError('NOT_CONFIGURED', 'Supabase is not configured.');
  return supabase;
}

function requireId(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BillShareServiceError('INVALID', 'That bill could not be found.');
  }
  return value.trim();
}

function requireUuid(value: string): string {
  const id = requireId(value);
  if (!UUID_PATTERN.test(id)) throw new BillShareServiceError('INVALID', 'That bill could not be found.');
  return id;
}

function requireToken(value: string): string {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new BillShareServiceError('INVALID', 'This split link is expired or has been turned off by the host.');
  }
  return value;
}

function asShareError(error: unknown, fallbackCode: BillShareCode, fallback: string): BillShareServiceError {
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

function parseSharedBill(value: unknown): SharedBill {
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

function parseHostClaimState(value: unknown): HostClaimState {
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

function asRecord(value: unknown): Record<string, unknown> | null {
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
