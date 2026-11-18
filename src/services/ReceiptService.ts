import type { PostgrestError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';
import type { Item, Receipt, ReceiptStatus, Split } from '@/types/database.types';

const DEFAULT_CURRENCY = 'GBP';
const MONEY_LIMIT = 99_999_999.99;

type ReceiptServiceCode = 'INSERT_FAILED' | 'UPDATE_FAILED' | 'FETCH_FAILED' | 'CLAIM_FAILED' | 'VALIDATION_ERROR' | 'NOT_CONFIGURED';

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
        .select()
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

  async updateReceiptTotals(receiptId: string, updates: ReceiptTotalsUpdate): Promise<Receipt> {
    try {
      const id = requireId(receiptId, 'receiptId');
      const payload = normalizeTotals(updates);
      const client = requireClient();
      const { data, error } = await client.from('receipts').update(payload).eq('id', id).select().single();

      if (error) throw new ReceiptServiceError('UPDATE_FAILED', error.message, error);
      return parseReceipt(data, 'UPDATE_FAILED');
    } catch (caught) {
      throw logged('updateReceiptTotals', 'UPDATE_FAILED', 'Could not update the receipt totals.', caught);
    }
  }

  async getReceiptWithItems(receiptId: string): Promise<{ receipt: Receipt; items: Item[]; splits: Split[] }> {
    try {
      const id = requireId(receiptId, 'receiptId');
      const client = requireClient();

      const receiptResult = await client.from('receipts').select('*').eq('id', id).single();
      if (receiptResult.error) throw new ReceiptServiceError('FETCH_FAILED', receiptResult.error.message, receiptResult.error);

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
}

export const receiptService = new ReceiptService();

function requireClient() {
  if (!supabase) {
    throw new ReceiptServiceError('NOT_CONFIGURED', 'Supabase is not configured.');
  }
  return supabase;
}

function logged(method: string, code: ReceiptServiceCode, fallback: string, caught: unknown): ReceiptServiceError {
  const error = caught instanceof ReceiptServiceError ? caught : new ReceiptServiceError(code, fallback, caught instanceof Error ? caught : null);
  console.error(`[ReceiptService] [${method}] Error: ${error.message}`, caught);
  return error;
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

function parseReceipt(value: unknown, code: ReceiptServiceCode): Receipt {
  const row = asRecord(value, 'Receipt', code);
  return {
    id: readString(row, 'id', code),
    host_id: readString(row, 'host_id', code),
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
    status: readStatus(row, code),
    created_at: readString(row, 'created_at', code),
  } as Receipt;
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