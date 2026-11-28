import { getWebBaseUrl } from '@/lib/url';
import { supabase } from '@/lib/supabase';

import {
  asRecord,
  asShareError,
  BillShareServiceError,
  parseHostClaimState,
  parseSharedBill,
  runReadRpc,
  UUID_PATTERN,
} from './billShareCore';

export { BillShareServiceError, type BillShareCode } from './billShareCore';

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
  hostConfirmedAt: string | null;
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
    hostConfirmedAt: string | null;
    viewerIsHost: boolean;
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

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,}$/;

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
    // Read-only: one bounded retry on a transient network drop.
    return runReadRpc(
      () => requireClient().rpc('get_shared_bill', { p_share_token: shareToken }),
      parseSharedBill,
      'Could not load this split.',
    );
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
    // Read-only: one bounded retry on a transient network drop.
    return runReadRpc(
      () => requireClient().rpc('get_host_claim_state', { p_receipt_id: id }),
      parseHostClaimState,
      'Could not load your items.',
    );
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

  async confirmHostItems(receiptId: string, itemIds: readonly string[]): Promise<HostClaimState | null> {
    const id = requireUuid(receiptId);
    const claimed = itemIds.map((itemId) => requireUuid(itemId));
    try {
      const client = requireClient();
      const { data, error } = await client.rpc('confirm_host_items', {
        p_receipt_id: id,
        p_item_ids: claimed,
      });
      if (error) throw error;
      if (data == null) return null;
      return parseHostClaimState(data);
    } catch (error) {
      throw asShareError(error, 'FAILED', 'Could not confirm your items.');
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

