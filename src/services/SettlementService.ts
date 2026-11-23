import { supabase } from '@/lib/supabase';
import { logger } from '@/utils/logger';
import type {
  Receipt,
  ReceiptSplit,
  RecordSettlementArgs,
  Settlement,
  SettlementPaymentMethod,
  VoidSettlementArgs,
} from '@/types/database.types';

export type SettlementServiceCode = 'NOT_CONFIGURED' | 'FETCH_FAILED' | 'SAVE_FAILED' | 'VALIDATION_ERROR';

export type GroupLedgerData = {
  receipts: Receipt[];
  splits: ReceiptSplit[];
  settlements: Settlement[];
};

export type RecordSettlementParams = {
  groupId: string;
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
  paymentMethod?: SettlementPaymentMethod;
  note?: string | null;
  idempotencyKey?: string;
};

const PAYMENT_METHODS: readonly SettlementPaymentMethod[] = ['manual', 'payment_link', 'open_banking'];

export class SettlementServiceError extends Error {
  readonly code: SettlementServiceCode;

  constructor(code: SettlementServiceCode, message: string) {
    super(message);
    this.name = 'SettlementServiceError';
    this.code = code;
  }
}

type RandomUuidSource = {
  randomUUID?: () => string;
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
};

export function createIdempotencyKey(): string {
  const cryptoApi = (globalThis as { crypto?: RandomUuidSource }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class SettlementService {
  async getGroupSettlements(groupId: string): Promise<Settlement[]> {
    try {
      const client = requireClient();
      const { data, error } = await client
        .from('settlements')
        .select('*')
        .eq('group_id', groupId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return ((data ?? []) as unknown[]).map((row) => parseSettlement(row));
    } catch (error) {
      throw asSettlementError(error, 'FETCH_FAILED', 'Could not load settlements.');
    }
  }

  async getGroupLedgerData(groupId: string): Promise<GroupLedgerData> {
    try {
      const client = requireClient();
      const [receiptsResult, splitsResult, settlementsResult] = await Promise.all([
        client.from('receipts').select('*, settled_at, settled_by').eq('group_id', groupId).order('created_at', { ascending: false }),
        client
          .from('receipt_splits')
          .select('id, receipt_id, user_id, amount_minor, item_ids, updated_at, receipts!inner(group_id)')
          .eq('receipts.group_id', groupId),
        client.from('settlements').select('*').eq('group_id', groupId).order('created_at', { ascending: false }),
      ]);

      if (receiptsResult.error) throw receiptsResult.error;
      if (settlementsResult.error) throw settlementsResult.error;

      const splitRows = splitsResult.error
        ? await loadSplitsForReceipts(client, (receiptsResult.data ?? []) as { id?: unknown }[])
        : ((splitsResult.data ?? []) as unknown[]);

      return {
        receipts: (receiptsResult.data ?? []) as Receipt[],
        splits: splitRows.map((row) => parseSplit(row)),
        settlements: ((settlementsResult.data ?? []) as unknown[]).map((row) => parseSettlement(row)),
      };
    } catch (error) {
      throw asSettlementError(error, 'FETCH_FAILED', 'Could not load group balances.');
    }
  }

  async recordSettlement(params: RecordSettlementParams): Promise<Settlement> {
    if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0) {
      throw new SettlementServiceError('VALIDATION_ERROR', 'Amount must be a positive number of pence.');
    }
    if (params.fromUserId === params.toUserId) {
      throw new SettlementServiceError('VALIDATION_ERROR', 'Settlement parties must be different users.');
    }

    const idempotencyKey = params.idempotencyKey?.trim() || createIdempotencyKey();
    if (!idempotencyKey) {
      throw new SettlementServiceError('VALIDATION_ERROR', 'Invalid idempotency key.');
    }

    const args: RecordSettlementArgs = {
      p_group_id: params.groupId,
      p_from_user_id: params.fromUserId,
      p_to_user_id: params.toUserId,
      p_amount_minor: params.amountMinor,
      p_idempotency_key: idempotencyKey,
      p_payment_method: params.paymentMethod ?? 'manual',
      p_note: params.note ?? null,
    };

    try {
      const client = requireClient();
      const { data, error } = await client.rpc('record_settlement', args);
      if (error) throw error;
      return parseSettlement(firstRpcRow(data));
    } catch (error) {
      throw asSettlementError(error, 'SAVE_FAILED', 'Could not record this payment.');
    }
  }

  async voidSettlement(settlementId: string): Promise<Settlement> {
    const args: VoidSettlementArgs = { p_settlement_id: settlementId };

    try {
      const client = requireClient();
      const { data, error } = await client.rpc('void_settlement', args);
      if (error) throw error;
      return parseSettlement(firstRpcRow(data));
    } catch (error) {
      throw asSettlementError(error, 'SAVE_FAILED', 'Could not void this settlement.');
    }
  }
}

export const settlementService = new SettlementService();

async function loadSplitsForReceipts(client: NonNullable<typeof supabase>, receipts: { id?: unknown }[]) {
  const ids = receipts.flatMap((receipt) => (typeof receipt.id === 'string' && receipt.id ? [receipt.id] : []));
  if (ids.length === 0) return [];

  const { data, error } = await client.from('receipt_splits').select('*').in('receipt_id', ids);
  if (error) throw error;
  return (data ?? []) as unknown[];
}

function requireClient() {
  if (!supabase) {
    throw new SettlementServiceError('NOT_CONFIGURED', 'Supabase is not configured.');
  }
  return supabase;
}

function asSettlementError(error: unknown, code: SettlementServiceCode, fallback: string): SettlementServiceError {
  if (error instanceof SettlementServiceError) return error;

  logger.error('SettlementService', { code });
  return new SettlementServiceError(code, fallback);
}

function firstRpcRow(data: unknown): unknown {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

function parseSettlement(value: unknown): Settlement {
  if (!value || typeof value !== 'object') {
    throw new SettlementServiceError('SAVE_FAILED', 'Settlement response was empty.');
  }

  const row = value as Record<string, unknown>;
  const paymentMethod = row.payment_method;
  if (!isPaymentMethod(paymentMethod)) {
    throw new SettlementServiceError('VALIDATION_ERROR', 'Unknown settlement payment method.');
  }

  return {
    id: readId(row.id, 'settlement id'),
    group_id: readId(row.group_id, 'group id'),
    from_user_id: readId(row.from_user_id, 'from user'),
    to_user_id: readId(row.to_user_id, 'to user'),
    amount_minor: readMinor(row.amount_minor, 'amount_minor'),
    currency: typeof row.currency === 'string' && row.currency.trim() ? row.currency : 'GBP',
    idempotency_key: typeof row.idempotency_key === 'string' ? row.idempotency_key : '',
    payment_method: paymentMethod,
    note: typeof row.note === 'string' ? row.note : null,
    voided_at: typeof row.voided_at === 'string' ? row.voided_at : null,
    voided_by: typeof row.voided_by === 'string' ? row.voided_by : null,
    created_by: readId(row.created_by, 'created by'),
    created_at: typeof row.created_at === 'string' ? row.created_at : new Date(0).toISOString(),
  };
}

function parseSplit(value: unknown): ReceiptSplit {
  if (!value || typeof value !== 'object') {
    throw new SettlementServiceError('FETCH_FAILED', 'Split response was empty.');
  }

  const row = value as Record<string, unknown>;
  const itemIds = Array.isArray(row.item_ids) ? row.item_ids.filter((itemId): itemId is string => typeof itemId === 'string') : [];

  return {
    id: readId(row.id, 'split id'),
    receipt_id: readId(row.receipt_id, 'receipt id'),
    user_id: readId(row.user_id, 'user id'),
    amount_minor: readMinor(row.amount_minor, 'amount_minor'),
    item_ids: itemIds,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : new Date(0).toISOString(),
  };
}

function isPaymentMethod(value: unknown): value is SettlementPaymentMethod {
  return typeof value === 'string' && PAYMENT_METHODS.some((method) => method === value);
}

function readId(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SettlementServiceError('VALIDATION_ERROR', `Missing ${label}.`);
  }
  return value;
}

function readMinor(value: unknown, label: string) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new SettlementServiceError('VALIDATION_ERROR', `${label} must be an integer number of pence.`);
}
