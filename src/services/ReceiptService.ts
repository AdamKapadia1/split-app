import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import { logger } from '@/utils/logger';
import { mapErrorToUserMessage } from '@/utils/errorMapper';
import type { Item, Receipt, ReceiptSplit, ReceiptStatus, SetReceiptSettledArgs, Split } from '@/types/database.types';
import { toMinorUnits } from '@/utils/money';
import { assertReceiptImagePath } from '@/utils/receiptImage';
import {
  buildReceiptHistoryKeysetFilter,
  escapeIlikePattern,
  isValidGroupUuid,
  normalizeHistorySearchQuery,
  sliceLookaheadPage,
  type ReceiptHistoryCursor,
  type ReceiptHistoryGroupFilter,
  type ReceiptHistoryItem,
  type ReceiptHistoryPage,
} from '@/utils/receiptHistory';

const DEFAULT_CURRENCY = 'GBP';
const MONEY_LIMIT = 99_999_999.99;

type ReceiptServiceCode = 'INSERT_FAILED' | 'UPDATE_FAILED' | 'FETCH_FAILED' | 'CLAIM_FAILED' | 'SAVE_FAILED' | 'SETTLE_FAILED' | 'VALIDATION_ERROR' | 'NOT_CONFIGURED';

const RECEIPT_COLUMNS = 'id, host_id, paid_by, group_id, merchant_name, restaurant_name, website, currency_code, subtotal, tax_amount, service_charge, tip_amount, total_amount, image_url, image_path, status, settled_at, settled_by, created_at';

type ReceiptTotalsUpdate = Partial<
  Pick<Receipt, 'subtotal' | 'tax_amount' | 'service_charge' | 'total_amount' | 'status' | 'merchant_name'> & {
    restaurant_name?: string | null;
    website?: string | null;
  }
>;

type ScannedItem = Omit<Item, 'id' | 'receipt_id'> & { name?: string };

const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['scanning', 'open', 'locked', 'settled'];

export class ReceiptServiceError extends Error {
  readonly code: ReceiptServiceCode;
  readonly originalError: PostgrestError | Error | null;

  constructor(code: ReceiptServiceCode, message: string, originalError: PostgrestError | Error | null = null) {
    super(message);
    this.name = 'ReceiptServiceError';
    this.code = code;
    this.originalError = originalError;
  }
}

export class ReceiptService {
  async createEmptyReceipt(hostId: string, groupId: string | null = null): Promise<Receipt> {
    try {
      const host = requireId(hostId, 'hostId');
      const client = requireClient();
      const { data, error } = await client
        .from('receipts')
        .insert({
          host_id: host,
          group_id: groupId, // Maps to the selected group, or null for personal
          currency_code: DEFAULT_CURRENCY,
          subtotal: 0,
          tax_amount: 0,
          service_charge: 0,
          tip_amount: 0,
          total_amount: 0,
          status: 'scanning' satisfies ReceiptStatus,
        })
        .select(RECEIPT_COLUMNS)
        .single();

      if (error) throw new ReceiptServiceError('INSERT_FAILED', error.message, error);
      return parseReceipt(data, 'INSERT_FAILED');
    } catch (caught) {
      throw logged('createEmptyReceipt', 'INSERT_FAILED', 'Could not create the receipt.', caught);
    }
  }

  async addScannedItems(receiptId: string, items: ScannedItem[]): Promise<Item[]> {
    if (items.length === 0) return [];

    try {
      const id = requireId(receiptId, 'receiptId');
      const rows = items.map((item, index) => ({
        receipt_id: id,
        line_index: index, // Saves the exact layout order
        original_name: requireName(item.original_name || item.name || '', index),
        display_name: requireNullableName(item.display_name ?? null, index),
        price: requireMoney(item.price, `items[${index}].price`),
        quantity: requireQuantity(item.quantity ?? 1, index),
        is_tax_exempt: requireBoolean(item.is_tax_exempt ?? false, index),
      }));

      const client = requireClient();
      const { data, error } = await client.from('items').insert(rows).select();

      if (error) throw new ReceiptServiceError('INSERT_FAILED', error.message, error);
      return parseItems(data, 'INSERT_FAILED');
    } catch (caught) {
      throw logged('addScannedItems', 'INSERT_FAILED', 'Could not save the scanned items.', caught);
    }
  }

  async setReceiptImagePath(receiptId: string, imagePath: string): Promise<void> {
    try {
      const id = requireId(receiptId, 'receiptId');
      const path = assertReceiptImagePath(imagePath);
      const client = requireClient();
      const { error } = await client.from('receipts').update({ image_path: path }).eq('id', id);
      if (error) throw new ReceiptServiceError('UPDATE_FAILED', error.message, error);
    } catch (caught) {
      throw logged('setReceiptImagePath', 'UPDATE_FAILED', 'Could not save the receipt photo.', caught);
    }
  }

  async updateReceiptTotals(receiptId: string, updates: ReceiptTotalsUpdate): Promise<Receipt> {
    try {
      const id = requireId(receiptId, 'receiptId');
      const payload = normalizeTotals(updates);
      const client = requireClient();
      const { data, error } = await client.from('receipts').update(payload).eq('id', id).select(RECEIPT_COLUMNS).single();

      if (error) throw new ReceiptServiceError('UPDATE_FAILED', error.message, error);
      return parseReceipt(data, 'UPDATE_FAILED');
    } catch (caught) {
      throw logged('updateReceiptTotals', 'UPDATE_FAILED', 'Could not update the receipt totals.', caught);
    }
  }

  async getReceiptWithItems(receiptId: string): Promise<{ receipt: Receipt; items: Item[]; splits: Split[] } | null> {
    try {
      const id = requireId(receiptId, 'receiptId');
      const client = requireClient();

      const receiptResult = await client.from('receipts').select(RECEIPT_COLUMNS).eq('id', id).maybeSingle();
      if (receiptResult.error) throw new ReceiptServiceError('FETCH_FAILED', receiptResult.error.message, receiptResult.error);
      if (!receiptResult.data) return null;

      // Fetches items sorted by line_index instead of random ID
      const itemsResult = await client.from('items').select('*').eq('receipt_id', id).order('line_index', { ascending: true });
      if (itemsResult.error) throw new ReceiptServiceError('FETCH_FAILED', itemsResult.error.message, itemsResult.error);

      const splitsResult = await client.from('splits').select('*').eq('receipt_id', id);
      if (splitsResult.error) throw new ReceiptServiceError('FETCH_FAILED', splitsResult.error.message, splitsResult.error);

      return {
        receipt: parseReceipt(receiptResult.data, 'FETCH_FAILED'),
        items: parseItems(itemsResult.data, 'FETCH_FAILED'),
        splits: parseSplits(splitsResult.data, 'FETCH_FAILED'),
      };
    } catch (caught) {
      throw logged('getReceiptWithItems', 'FETCH_FAILED', 'Could not load the receipt.', caught);
    }
  }

  async toggleItemClaim(itemId: string, userId: string, receiptId: string): Promise<void> {
    try {
      const item = requireId(itemId, 'itemId');
      const user = requireId(userId, 'userId');
      const receipt = requireId(receiptId, 'receiptId');
      const client = requireClient();

      const existing = await client.from('splits').select('*').eq('item_id', item).eq('user_id', user).single();
      if (existing.error && !isMissingRow(existing.error)) throw new ReceiptServiceError('CLAIM_FAILED', existing.error.message, existing.error);

      if (existing.data && !existing.error) {
        const split = parseSplit(existing.data, 'CLAIM_FAILED');
        const removed = await client.from('splits').delete().eq('id', split.id);
        if (removed.error) throw new ReceiptServiceError('CLAIM_FAILED', removed.error.message, removed.error);
        return;
      }

      const inserted = await client.from('splits').insert({ item_id: itemId, user_id: userId, receipt_id: receiptId, amount_owed: 0 });
      if (inserted.error) throw new ReceiptServiceError('CLAIM_FAILED', inserted.error.message, inserted.error);
    } catch (caught) {
      throw logged('toggleItemClaim', 'CLAIM_FAILED', 'Could not update the claim.', caught);
    }
  }

  async getReceiptSplits(receiptId: string): Promise<ReceiptSplit[]> {
    try {
      const id = requireId(receiptId, 'receiptId');
      const client = requireClient();
      const { data, error } = await client.from('receipt_splits').select('*').eq('receipt_id', id);
      if (error) throw new ReceiptServiceError('FETCH_FAILED', error.message, error);
      return parseReceiptSplits(data, 'FETCH_FAILED');
    } catch (caught) {
      throw logged('getReceiptSplits', 'FETCH_FAILED', 'Could not load the saved split.', caught);
    }
  }

  async saveReceiptSplits(
    receiptId: string,
    paidByUserId: string,
    splits: { user_id: string; amount_minor: number; item_ids: string[] }[],
  ): Promise<void> {
    try {
      const id = requireId(receiptId, 'receiptId');
      const paidBy = requireId(paidByUserId, 'paidByUserId');
      const payload = splits.map((split, index) => ({
        user_id: requireId(split.user_id, `splits[${index}].user_id`),
        amount_minor: requireMinor(split.amount_minor, index),
        item_ids: requireItemIds(split.item_ids, index),
      }));
      const client = requireClient();
      const { error } = await client.rpc('save_receipt_splits', {
        p_receipt_id: id,
        p_paid_by: paidBy,
        p_splits: payload,
      });
      if (error) throw new ReceiptServiceError('SAVE_FAILED', error.message, error);
    } catch (caught) {
      throw logged('saveReceiptSplits', 'SAVE_FAILED', 'Could not save the split.', caught);
    }
  }

  async setReceiptSettled(receiptId: string, settled: boolean): Promise<Receipt> {
    const id = requireId(receiptId, 'receiptId');
    if (typeof settled !== 'boolean') {
      throw new ReceiptServiceError('VALIDATION_ERROR', 'settled must be a boolean.');
    }

    try {
      const client = requireClient();
      const args: SetReceiptSettledArgs = { p_receipt_id: id, p_settled: settled };
      const { data, error } = await client.rpc('set_receipt_settled', args);
      if (error) {
        throw new ReceiptServiceError('SETTLE_FAILED', 'Could not update the receipt.', error);
      }

      const row = Array.isArray(data) ? data[0] : data;
      if (!row) {
        throw new ReceiptServiceError('SETTLE_FAILED', 'Could not update the receipt.');
      }
      return parseReceipt(row, 'SETTLE_FAILED');
    } catch (caught) {
      if (caught instanceof ReceiptServiceError) throw caught;
      throw new ReceiptServiceError('SETTLE_FAILED', 'Could not update the receipt.', caught instanceof Error ? caught : null);
    }
  }

  /**
   * One keyset page of History, newest first.
   * Reads `limit + 1` rows so the extra row can say "there is another page"
   * without a full-table count. Group names are resolved in the same round trip.
   * A missing or deleted group leaves `group_name` null so the row stays Personal.
   * Search and group chips are applied in Postgres, across the whole RLS-visible ledger.
   */
  async fetchReceiptHistoryPage({
    limit,
    cursor,
    searchQuery,
    groupFilter,
    signal,
  }: {
    limit: number;
    cursor?: ReceiptHistoryCursor | null;
    searchQuery?: string;
    groupFilter?: ReceiptHistoryGroupFilter;
    signal?: AbortSignal;
  }): Promise<ReceiptHistoryPage<ReceiptHistoryItem>> {
    try {
      const pageLimit = requirePageLimit(limit);
      const keyset = cursor ? requireKeysetFilter(cursor) : null;
      const client = requireClient();
      let receiptsQuery = client
        .from('receipts')
        .select(RECEIPT_COLUMNS)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(pageLimit + 1);

      receiptsQuery = applyHistoryGroupFilter(receiptsQuery, groupFilter);
      const merchantQuery = normalizeHistorySearchQuery(searchQuery ?? '');
      if (merchantQuery.length > 0) {
        receiptsQuery = receiptsQuery.ilike('merchant_name', `%${escapeIlikePattern(merchantQuery)}%`);
      }
      if (keyset) receiptsQuery = receiptsQuery.or(keyset);

      let groupsQuery = client.from('groups').select('id, name');
      if (signal) {
        receiptsQuery = receiptsQuery.abortSignal(signal);
        groupsQuery = groupsQuery.abortSignal(signal);
      }

      const [receiptsResult, groupsResult] = await Promise.all([
        receiptsQuery,
        groupsQuery,
      ]);

      if (signal?.aborted || isAbortError(receiptsResult.error)) throw abortError(receiptsResult.error);
      if (receiptsResult.error) {
        throw new ReceiptServiceError('FETCH_FAILED', receiptsResult.error.message, receiptsResult.error);
      }
      if (signal?.aborted || isAbortError(groupsResult.error)) throw abortError(groupsResult.error);
      if (groupsResult.error) {
        logger.error('ReceiptService', { method: 'fetchReceiptHistoryPage', code: 'GROUPS_FAILED' });
      }

      const names = groupsResult.error ? new Map<string, string>() : groupNameMap(groupsResult.data);
      const parsed: StoredReceipt[] = [];
      for (const row of receiptsResult.data ?? []) {
        try {
          parsed.push(parseReceipt(row, 'FETCH_FAILED'));
        } catch (error) {
          logger.error('ReceiptService', { method: 'fetchReceiptHistoryPage', code: 'ROW_FAILED' });
        }
      }

      const page = sliceLookaheadPage(parsed, pageLimit);
      return {
        items: page.items.map((receipt) => toReceiptHistoryItem(receipt, names)),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      };
    } catch (caught) {
      if (signal?.aborted || isAbortError(caught)) throw abortError(caught);
      throw logged('fetchReceiptHistoryPage', 'FETCH_FAILED', 'Could not load receipt history.', caught);
    }
  }
}

/**
 * True when a History query was cancelled by a newer search, chip, or refresh.
 * Callers should ignore this. It is not a failed load.
 */
export function isAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;

  const record = err as {
    name?: unknown;
    message?: unknown;
    signal?: { aborted?: boolean } | null;
    originalError?: unknown;
  };
  if (record.signal?.aborted === true) return true;

  const name = typeof record.name === 'string' ? record.name : '';
  const message = typeof record.message === 'string' ? record.message : '';
  if (name === 'AbortError') return true;
  if (message.length > 0 && (/abort/i.test(message) || /the operation was aborted/i.test(message))) return true;

  const original = record.originalError;
  if (original && original !== err && isAbortError(original)) return true;
  return false;
}

type StoredReceipt = Receipt & {
  restaurant_name: string | null;
  website: string | null;
};

export const receiptService = new ReceiptService();

function groupNameMap(rows: unknown) {
  const names = new Map<string, string>();
  if (!Array.isArray(rows)) return names;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as { id?: unknown; name?: unknown };
    if (typeof record.id !== 'string' || !record.id.trim()) continue;
    if (typeof record.name !== 'string' || !record.name.trim()) continue;
    names.set(record.id, record.name.trim());
  }

  return names;
}

function requireClient() {
  if (!supabase) {
    throw new ReceiptServiceError('NOT_CONFIGURED', 'Supabase is not configured.');
  }
  return supabase;
}

function logged(method: string, code: ReceiptServiceCode, fallback: string, caught: unknown): ReceiptServiceError {
  const error = caught instanceof ReceiptServiceError ? caught : new ReceiptServiceError(code, fallback, caught instanceof Error ? caught : null);
  const message = mapErrorToUserMessage(error.originalError ?? error, fallback);
  logger.error('ReceiptService', { method, code: error.code });
  if (message === error.message) return error;
  return new ReceiptServiceError(error.code, message, error.originalError);
}

function requirePageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ReceiptServiceError('VALIDATION_ERROR', 'limit must be an integer from 1 to 100.');
  }
  return limit;
}

function requireKeysetFilter(cursor: ReceiptHistoryCursor): string {
  try {
    return buildReceiptHistoryKeysetFilter(cursor);
  } catch (error) {
    throw new ReceiptServiceError('VALIDATION_ERROR', 'History cursor is invalid.', error instanceof Error ? error : null);
  }
}

function applyHistoryGroupFilter<Query extends { eq: (column: string, value: string) => Query; is: (column: string, value: null) => Query }>(
  query: Query,
  groupFilter: ReceiptHistoryGroupFilter | undefined,
): Query {
  if (groupFilter === undefined || groupFilter === 'all') return query;
  if (groupFilter === 'ungrouped') return query.is('group_id', null);
  if (!isValidGroupUuid(groupFilter)) {
    throw new ReceiptServiceError('VALIDATION_ERROR', 'groupFilter must be "all", "ungrouped", or a group id.');
  }
  return query.eq('group_id', groupFilter);
}

function abortError(source: unknown): Error {
  const message = source instanceof Error
    ? source.message
    : source && typeof source === 'object' && 'message' in source && typeof source.message === 'string'
      ? source.message
      : 'The request was aborted.';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function toReceiptHistoryItem(receipt: StoredReceipt, names: Map<string, string>): ReceiptHistoryItem {
  const groupId = receipt.group_id;
  return {
    id: receipt.id,
    group_id: groupId,
    group_name: groupId ? names.get(groupId) ?? null : null,
    merchant_name: receipt.merchant_name,
    restaurant_name: receipt.restaurant_name,
    total_minor: toMinorUnits(Number(receipt.total_amount || 0)),
    created_at: receipt.created_at,
  };
}

function requireId(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ReceiptServiceError('VALIDATION_ERROR', `${field} must be a non-empty string.`);
  return value.trim();
}

function requireMoney(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ReceiptServiceError('VALIDATION_ERROR', `${field} must be a finite numeric(10,2) amount.`);
  const rounded = Number(value.toFixed(2));
  if (Math.abs(rounded) > MONEY_LIMIT) throw new ReceiptServiceError('VALIDATION_ERROR', `${field} exceeds numeric(10,2).`);
  return rounded;
}

function requireName(value: string, index: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new ReceiptServiceError('VALIDATION_ERROR', `items[${index}].original_name must be a non-empty string.`);
  return value.trim();
}

function requireNullableName(value: string | null, index: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ReceiptServiceError('VALIDATION_ERROR', `items[${index}].display_name must be a string or null.`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requireQuantity(value: number, index: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new ReceiptServiceError('VALIDATION_ERROR', `items[${index}].quantity must be a positive integer.`);
  return value;
}

function requireBoolean(value: boolean, index: number): boolean {
  if (typeof value !== 'boolean') throw new ReceiptServiceError('VALIDATION_ERROR', `items[${index}].is_tax_exempt must be a boolean.`);
  return value;
}

function requireMinor(value: number, index: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ReceiptServiceError('VALIDATION_ERROR', `splits[${index}].amount_minor must be a non-negative integer.`);
  }
  return value;
}

function requireItemIds(value: string[], index: number): string[] {
  if (!Array.isArray(value)) throw new ReceiptServiceError('VALIDATION_ERROR', `splits[${index}].item_ids must be a list.`);
  return value.map((itemId, itemIndex) => requireId(itemId, `splits[${index}].item_ids[${itemIndex}]`));
}

function normalizeTotals(updates: ReceiptTotalsUpdate): ReceiptTotalsUpdate {
  const payload: ReceiptTotalsUpdate = {};
  const moneyFields = ['subtotal', 'tax_amount', 'service_charge', 'total_amount'] as const;
  const stringFields = ['merchant_name', 'restaurant_name', 'website'] as const;

  for (const field of moneyFields) {
    if (updates[field] !== undefined) {
      payload[field] = requireMoney(updates[field], field);
    }
  }

  for (const field of stringFields) {
    if (updates[field] !== undefined) {
      payload[field] = updates[field];
    }
  }

  if (updates.status !== undefined) {
    if (!RECEIPT_STATUSES.includes(updates.status)) throw new ReceiptServiceError('VALIDATION_ERROR', 'invalid status');
    payload.status = updates.status;
  }

  if (Object.keys(payload).length === 0) throw new ReceiptServiceError('VALIDATION_ERROR', 'updateReceiptTotals requires at least one field.');
  return payload;
}

function parseReceipt(value: unknown, code: ReceiptServiceCode): StoredReceipt {
  const row = asRecord(value, 'Receipt', code);
  return {
    id: readString(row, 'id', code),
    host_id: readString(row, 'host_id', code),
    paid_by: readNullableString(row, 'paid_by', code),
    group_id: readNullableString(row, 'group_id', code),
    merchant_name: readNullableString(row, 'merchant_name', code),
    restaurant_name: readNullableString(row, 'restaurant_name', code),
    website: readNullableString(row, 'website', code),
    currency_code: readString(row, 'currency_code', code),
    subtotal: readStoredMoney(row, 'subtotal', code),
    tax_amount: readStoredMoney(row, 'tax_amount', code),
    service_charge: readStoredMoney(row, 'service_charge', code),
    tip_amount: readStoredMoney(row, 'tip_amount', code),
    total_amount: readStoredMoney(row, 'total_amount', code),
    image_url: readNullableString(row, 'image_url', code),
    image_path: readNullableString(row, 'image_path', code),
    status: readStatus(row, code),
    settled_at: readNullableString(row, 'settled_at', code),
    settled_by: readNullableString(row, 'settled_by', code),
    created_at: readString(row, 'created_at', code),
  };
}

function parseItems(value: unknown, code: ReceiptServiceCode): Item[] {
  if (!Array.isArray(value)) throw new ReceiptServiceError(code, 'Items response was not a list of rows.');
  return value.map((entry) => {
    const row = asRecord(entry, 'Item', code);
    return {
      id: readString(row, 'id', code),
      receipt_id: readString(row, 'receipt_id', code),
      original_name: readString(row, 'original_name', code),
      display_name: readNullableString(row, 'display_name', code),
      price: readStoredMoney(row, 'price', code),
      quantity: readStoredQuantity(row, code),
      is_tax_exempt: readStoredBoolean(row, 'is_tax_exempt', code),
    };
  });
}

function parseSplits(value: unknown, code: ReceiptServiceCode): Split[] {
  if (!Array.isArray(value)) throw new ReceiptServiceError(code, 'Splits response was not a list of rows.');
  return value.map((entry) => parseSplit(entry, code));
}

function parseSplit(value: unknown, code: ReceiptServiceCode): Split {
  const row = asRecord(value, 'Split', code);
  return {
    id: readString(row, 'id', code),
    receipt_id: readString(row, 'receipt_id', code),
    item_id: readString(row, 'item_id', code),
    user_id: readString(row, 'user_id', code),
  };
}

function parseReceiptSplits(value: unknown, code: ReceiptServiceCode): ReceiptSplit[] {
  if (!Array.isArray(value)) throw new ReceiptServiceError(code, 'Receipt splits response was not a list of rows.');
  return value.map((entry) => {
    const row = asRecord(entry, 'ReceiptSplit', code);
    return {
      id: readString(row, 'id', code),
      receipt_id: readString(row, 'receipt_id', code),
      user_id: readString(row, 'user_id', code),
      amount_minor: readMinor(row, 'amount_minor', code),
      item_ids: readStringList(row, 'item_ids', code),
      updated_at: readString(row, 'updated_at', code),
    };
  });
}

function isMissingRow(error: PostgrestError): boolean {
  return error.code === 'PGRST116' && /0 rows/i.test(error.details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, label: string, code: ReceiptServiceCode): Record<string, unknown> {
  if (!isRecord(value)) throw new ReceiptServiceError(code, `${label} response was not a row.`);
  return value;
}

function readString(row: Record<string, unknown>, field: string, code: ReceiptServiceCode): string {
  const value = row[field];
  if (typeof value !== 'string' || value.length === 0) throw new ReceiptServiceError(code, `Response field ${field} was not a string.`);
  return value;
}

function readNullableString(row: Record<string, unknown>, field: string, code: ReceiptServiceCode): string | null {
  const value = row[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ReceiptServiceError(code, `Response field ${field} was not a string or null.`);
  return value;
}

function readStoredMoney(row: Record<string, unknown>, field: string, code: ReceiptServiceCode): number {
  const value = row[field];
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) throw new ReceiptServiceError(code, `Response field ${field} was not numeric(10,2).`);
  return requireMoney(numeric, field);
}

function readStatus(row: Record<string, unknown>, code: ReceiptServiceCode): ReceiptStatus {
  const value = row.status;
  if (!isReceiptStatus(value)) throw new ReceiptServiceError(code, 'Response field status was not a receipt status.');
  return value;
}

function isReceiptStatus(value: unknown): value is ReceiptStatus {
  return typeof value === 'string' && RECEIPT_STATUSES.some((status) => status === value);
}

function readStoredQuantity(row: Record<string, unknown>, code: ReceiptServiceCode): number {
  const value = row.quantity;
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 1) throw new ReceiptServiceError(code, 'Response field quantity was not a positive integer.');
  return numeric;
}

function readStoredBoolean(row: Record<string, unknown>, field: string, code: ReceiptServiceCode): boolean {
  const value = row[field];
  if (typeof value !== 'boolean') throw new ReceiptServiceError(code, `Response field ${field} was not a boolean.`);
  return value;
}

function readMinor(row: Record<string, unknown>, field: string, code: ReceiptServiceCode): number {
  const value = row[field];
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isInteger(numeric)) throw new ReceiptServiceError(code, `Response field ${field} was not an integer.`);
  return numeric;
}

function readStringList(row: Record<string, unknown>, field: string, code: ReceiptServiceCode): string[] {
  const value = row[field];
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ReceiptServiceError(code, `Response field ${field} was not a list.`);
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new ReceiptServiceError(code, `Response field ${field} contained a non-string id.`);
    }
    return entry;
  });
}