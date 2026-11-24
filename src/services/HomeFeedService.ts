import { supabase } from '@/lib/supabase';
import { mapErrorToUserMessage } from '@/utils/errorMapper';
import { logger } from '@/utils/logger';
import { toMinorUnits } from '@/utils/money';
import { NUDGE_COOLDOWN_MS } from '@/utils/notifications';

const HOME_RECEIPT_LIMIT = 1000;
const CHUNK = 80;

export type HomeFeedShare = {
  userId: string;
  displayName: string;
  amountPence: number;
  isOnCooldown: boolean;
};

export type HomeFeedReceipt = {
  id: string;
  hostId: string;
  paidBy: string | null;
  creditorName: string;
  merchantName: string | null;
  restaurantName: string | null;
  groupId: string | null;
  groupName: string | null;
  totalMinor: number;
  settled: boolean;
  createdAt: string;
  shares: HomeFeedShare[];
};

type ReceiptRow = {
  id: string;
  hostId: string;
  paidBy: string | null;
  groupId: string | null;
  merchantName: string | null;
  restaurantName: string | null;
  totalMinor: number;
  settled: boolean;
  createdAt: string;
};

type SplitRow = {
  receiptId: string;
  userId: string;
  amountPence: number;
};

/**
 * Receipts the member can see, with integer-pence shares and 24h nudge cooldowns.
 * Names stay in the returned rows. Logs carry codes only.
 */
export async function fetchHomeFeed(): Promise<HomeFeedReceipt[]> {
  if (!supabase) throw new Error('Could not load your balances.');
  const client = supabase;

  try {
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    const userId = sessionData.session?.user.id;
    if (!userId) throw new Error('Please sign in again.');

    const [receiptsResult, groupsResult] = await Promise.all([
      client
        .from('receipts')
        .select('id, host_id, paid_by, group_id, merchant_name, restaurant_name, total_amount, status, settled_at, created_at')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(HOME_RECEIPT_LIMIT),
      client.from('groups').select('id, name'),
    ]);

    if (receiptsResult.error) throw receiptsResult.error;
    const receipts = parseReceipts(receiptsResult.data);
    const groupNames = groupsResult.error ? new Map<string, string>() : parseNames(groupsResult.data, 'id', 'name');
    if (groupsResult.error) logger.error('home', { code: 'GROUPS_FAILED' });

    const receiptIds = receipts.map((receipt) => receipt.id);
    const splits = await loadSplits(client, receiptIds);
    const profileIds = new Set<string>();
    for (const receipt of receipts) {
      profileIds.add(receipt.hostId);
      if (receipt.paidBy) profileIds.add(receipt.paidBy);
    }
    for (const split of splits) profileIds.add(split.userId);

    const [names, cooldown] = await Promise.all([
      loadNames(client, [...profileIds]),
      loadCooldown(client, userId),
    ]);

    const sharesByReceipt = new Map<string, HomeFeedShare[]>();
    for (const split of splits) {
      const list = sharesByReceipt.get(split.receiptId) ?? [];
      list.push({
        userId: split.userId,
        displayName: names.get(split.userId) || 'Someone',
        amountPence: split.amountPence,
        isOnCooldown: cooldown.has(`${split.receiptId}:${split.userId}`),
      });
      sharesByReceipt.set(split.receiptId, list);
    }

    return receipts.map((receipt) => {
      const creditorId = receipt.paidBy || receipt.hostId;
      return {
        id: receipt.id,
        hostId: receipt.hostId,
        paidBy: receipt.paidBy,
        creditorName: names.get(creditorId) || 'Someone',
        merchantName: receipt.merchantName,
        restaurantName: receipt.restaurantName,
        groupId: receipt.groupId,
        groupName: receipt.groupId ? groupNames.get(receipt.groupId) ?? null : null,
        totalMinor: receipt.totalMinor,
        settled: receipt.settled,
        createdAt: receipt.createdAt,
        shares: sharesByReceipt.get(receipt.id) ?? [],
      };
    });
  } catch (error) {
    logger.error('home', { code: 'FETCH_FAILED' });
    throw new Error(mapErrorToUserMessage(error, 'Could not load your balances.'));
  }
}

async function loadSplits(
  client: NonNullable<typeof supabase>,
  receiptIds: readonly string[],
): Promise<SplitRow[]> {
  const rows: SplitRow[] = [];
  for (let index = 0; index < receiptIds.length; index += CHUNK) {
    const chunk = receiptIds.slice(index, index + CHUNK);
    const { data, error } = await client
      .from('receipt_splits')
      .select('receipt_id, user_id, amount_minor')
      .in('receipt_id', chunk);
    if (error) throw error;
    rows.push(...parseSplits(data));
  }
  return rows;
}

async function loadNames(client: NonNullable<typeof supabase>, userIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for (let index = 0; index < userIds.length; index += CHUNK) {
      const chunk = userIds.slice(index, index + CHUNK);
      if (chunk.length === 0) continue;
      const { data, error } = await client.from('profiles').select('id, full_name').in('id', chunk);
      if (error) throw error;
      for (const [id, name] of parseNames(data, 'id', 'full_name')) names.set(id, name);
    }
  } catch {
    logger.error('home', { code: 'NAMES_FAILED' });
  }
  return names;
}

async function loadCooldown(client: NonNullable<typeof supabase>, userId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const boundary = new Date(Date.now() - NUDGE_COOLDOWN_MS).toISOString();
    const { data, error } = await client
      .from('settlement_nudges')
      .select('receipt_id, recipient_id')
      .eq('sender_id', userId)
      .eq('delivery_status', 'sent')
      .gt('created_at', boundary);
    if (error) throw error;
    if (!Array.isArray(data)) return keys;
    for (const row of data) {
      if (!row || typeof row !== 'object') continue;
      const record = row as { receipt_id?: unknown; recipient_id?: unknown };
      if (typeof record.receipt_id !== 'string' || typeof record.recipient_id !== 'string') continue;
      keys.add(`${record.receipt_id}:${record.recipient_id}`);
    }
  } catch {
    logger.error('home', { code: 'NUDGES_FAILED' });
  }
  return keys;
}

function parseReceipts(value: unknown): ReceiptRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ReceiptRow[] = [];
  let dropped = false;
  for (const entry of value) {
    const row = parseReceipt(entry);
    if (row) rows.push(row);
    else dropped = true;
  }
  if (dropped) logger.error('home', { code: 'ROW_FAILED' });
  return rows;
}

function parseReceipt(value: unknown): ReceiptRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  const hostId = text(row.host_id);
  const createdAt = text(row.created_at);
  if (!id || !hostId || !createdAt) return null;
  const status = text(row.status);
  return {
    id,
    hostId,
    paidBy: text(row.paid_by) || null,
    groupId: text(row.group_id) || null,
    merchantName: text(row.merchant_name) || null,
    restaurantName: text(row.restaurant_name) || null,
    totalMinor: readTotalMinor(row.total_amount),
    settled: Boolean(text(row.settled_at)) || status === 'settled',
    createdAt,
  };
}

function parseSplits(value: unknown): SplitRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SplitRow[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const receiptId = text(row.receipt_id);
    const userId = text(row.user_id);
    const amountPence = readPence(row.amount_minor);
    if (!receiptId || !userId || amountPence === null) continue;
    rows.push({ receiptId, userId, amountPence });
  }
  return rows;
}

function parseNames(value: unknown, idKey: string, nameKey: string): Map<string, string> {
  const names = new Map<string, string>();
  if (!Array.isArray(value)) return names;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = text(row[idKey]);
    const name = text(row[nameKey]);
    if (id && name) names.set(id, name);
  }
  return names;
}

function readPence(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function readTotalMinor(value: unknown): number {
  const amount = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(amount)) return 0;
  return toMinorUnits(amount);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
