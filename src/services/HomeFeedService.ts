import { mapErrorToUserMessage } from '@/utils/errorMapper';
import { classifyTelemetry } from '@/utils/errorClassification';
import { logger } from '@/utils/logger';
import { toMinorUnits } from '@/utils/money';
import { NUDGE_COOLDOWN_MS } from '@/utils/notifications';

const HOME_RECEIPT_LIMIT = 1000;
const CHUNK = 80;

const OP = {
  session: 'fetchHomeFeed.session',
  receipts: 'fetchHomeFeed.receipts',
  groups: 'fetchHomeFeed.groups',
  splits: 'fetchHomeFeed.splits',
  profiles: 'fetchHomeFeed.profiles',
  nudges: 'fetchHomeFeed.nudges',
  summary: 'fetchHomeFeed.summary',
} as const;

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

type QueryResult = { data: unknown; error: unknown };

export type HomeFeedQuery = PromiseLike<QueryResult> & {
  select: (columns: string) => HomeFeedQuery;
  order: (column: string, options?: { ascending: boolean }) => HomeFeedQuery;
  limit: (count: number) => HomeFeedQuery;
  in: (column: string, values: readonly string[]) => HomeFeedQuery;
  eq: (column: string, value: string) => HomeFeedQuery;
  gt: (column: string, value: string) => HomeFeedQuery;
};

export type HomeFeedClient = {
  auth: {
    getSession: () => PromiseLike<{ data: unknown; error: unknown }>;
  };
  from: (table: string) => HomeFeedQuery;
};

export type HomeFeedRequestOptions = {
  isCurrent?: () => boolean;
  client?: HomeFeedClient | null;
};

/**
 * True when this generation is still the latest request and the screen is mounted.
 * Callers compare a monotonic id; superseded or unmounted work must not commit.
 */
export function shouldCommitHomeFeed(requestId: number, latestRequestId: number, isMounted: boolean): boolean {
  return isMounted && requestId === latestRequestId;
}

function isAbandoned(options: HomeFeedRequestOptions | undefined): boolean {
  if (!options?.isCurrent) return false;
  try {
    return options.isCurrent() !== true;
  } catch {
    return true;
  }
}

function isQuietFailure(error: unknown, operation: string, unauthenticated: boolean): boolean {
  try {
    return classifyTelemetry(error, { scope: 'home', operation, unauthenticated }).action === 'ignore';
  } catch {
    return false;
  }
}

function reportFailure(operation: string, error: unknown, unauthenticated: boolean) {
  if (isQuietFailure(error, operation, unauthenticated)) return;
  logger.error('home', { operation, error });
}

/**
 * Receipts the member can see, with integer-pence shares and 24h nudge cooldowns.
 * Names stay in the returned rows. Logs carry codes and operation keys only.
 * Pass `client` in tests or to skip the shared Supabase singleton.
 */
export async function fetchHomeFeed(options?: HomeFeedRequestOptions): Promise<HomeFeedReceipt[]> {
  let operation: string = OP.session;
  try {
    const client = await resolveClient(options);
    if (isAbandoned(options)) return [];
    if (!client) return [];

    const sessionResult = await client.auth.getSession();
    if (isAbandoned(options)) return [];
    const sessionError = readResult(sessionResult).error;
    if (sessionError) {
      if (isQuietFailure(sessionError, OP.session, true)) return [];
      throw sessionError;
    }
    const userId = readUserId(readResult(sessionResult).data);
    if (!userId) return [];

    operation = OP.receipts;
    const receiptsQuery = client
      .from('receipts')
      .select('id, host_id, paid_by, group_id, merchant_name, restaurant_name, total_amount, status, settled_at, created_at')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(HOME_RECEIPT_LIMIT);
    operation = OP.groups;
    const groupsQuery = client.from('groups').select('id, name');
    const [receiptsResult, groupsResult] = await Promise.all([receiptsQuery, groupsQuery]);
    if (isAbandoned(options)) return [];

    const receiptsPayload = readResult(receiptsResult);
    if (receiptsPayload.error) {
      operation = OP.receipts;
      throw receiptsPayload.error;
    }
    const groupsPayload = readResult(groupsResult);
    const receipts = parseReceipts(receiptsPayload.data, options);
    const groupNames = groupsPayload.error ? new Map<string, string>() : parseNames(groupsPayload.data, 'id', 'name');
    if (groupsPayload.error) reportFailure(OP.groups, groupsPayload.error, false);

    operation = OP.splits;
    const receiptIds = receipts.flatMap((receipt) => (typeof receipt?.id === 'string' && receipt.id ? [receipt.id] : []));
    const splits = await loadSplits(client, receiptIds, options);
    if (isAbandoned(options)) return [];

    const profileIds = new Set<string>();
    for (const receipt of receipts) {
      if (!receipt) continue;
      if (receipt.hostId) profileIds.add(receipt.hostId);
      if (receipt.paidBy) profileIds.add(receipt.paidBy);
    }
    for (const split of splits) {
      if (split?.userId) profileIds.add(split.userId);
    }

    operation = OP.summary;
    const [names, cooldown] = await Promise.all([
      loadNames(client, [...profileIds], options),
      loadCooldown(client, userId, options),
    ]);
    if (isAbandoned(options)) return [];

    const sharesByReceipt = new Map<string, HomeFeedShare[]>();
    for (const split of splits) {
      if (!split?.receiptId || !split.userId) continue;
      const list = sharesByReceipt.get(split.receiptId) ?? [];
      list.push({
        userId: split.userId,
        displayName: names.get(split.userId) || 'Someone',
        amountPence: split.amountPence,
        isOnCooldown: cooldown.has(`${split.receiptId}:${split.userId}`),
      });
      sharesByReceipt.set(split.receiptId, list);
    }

    return receipts.flatMap((receipt) => {
      if (!receipt?.id || !receipt.hostId || !receipt.createdAt) return [];
      const creditorId = receipt.paidBy || receipt.hostId;
      return [{
        id: receipt.id,
        hostId: receipt.hostId,
        paidBy: receipt.paidBy,
        creditorName: names.get(creditorId) || 'Someone',
        merchantName: receipt.merchantName,
        restaurantName: receipt.restaurantName,
        groupId: receipt.groupId,
        groupName: receipt.groupId ? groupNames.get(receipt.groupId) ?? null : null,
        totalMinor: Number.isFinite(receipt.totalMinor) ? receipt.totalMinor : 0,
        settled: receipt.settled,
        createdAt: receipt.createdAt,
        shares: sharesByReceipt.get(receipt.id) ?? [],
      }];
    });
  } catch (error) {
    if (isAbandoned(options) || isQuietFailure(error, operation, operation === OP.session)) return [];
    logger.error('home', { operation, error });
    throw new Error(mapErrorToUserMessage(error, 'Could not load your balances.'));
  }
}

async function resolveClient(options: HomeFeedRequestOptions | undefined): Promise<HomeFeedClient | null> {
  if (options && Object.prototype.hasOwnProperty.call(options, 'client')) {
    return options.client ?? null;
  }
  const loaded = await import('@/lib/supabase');
  if (!loaded.supabase) return null;
  return loaded.supabase as unknown as HomeFeedClient;
}

function readResult(value: unknown): QueryResult {
  if (!value || typeof value !== 'object') return { data: null, error: null };
  const record = value as { data?: unknown; error?: unknown };
  return { data: record.data ?? null, error: record.error ?? null };
}

function readUserId(sessionData: unknown): string {
  if (!sessionData || typeof sessionData !== 'object') return '';
  const session = (sessionData as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return '';
  const user = (session as { user?: unknown }).user;
  if (!user || typeof user !== 'object') return '';
  const id = (user as { id?: unknown }).id;
  return typeof id === 'string' ? id.trim() : '';
}

async function loadSplits(
  client: HomeFeedClient,
  receiptIds: readonly string[],
  options: HomeFeedRequestOptions | undefined,
): Promise<SplitRow[]> {
  const rows: SplitRow[] = [];
  const ids = receiptIds.filter((id) => typeof id === 'string' && id.trim());
  for (let index = 0; index < ids.length; index += CHUNK) {
    if (isAbandoned(options)) return rows;
    const chunk = ids.slice(index, index + CHUNK);
    const { data, error } = readResult(await client.from('receipt_splits').select('receipt_id, user_id, amount_minor').in('receipt_id', chunk));
    if (error) throw error;
    rows.push(...parseSplits(data));
  }
  return rows;
}

async function loadNames(
  client: HomeFeedClient,
  userIds: readonly string[],
  options: HomeFeedRequestOptions | undefined,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const ids = userIds.filter((id) => typeof id === 'string' && id.trim());
    for (let index = 0; index < ids.length; index += CHUNK) {
      if (isAbandoned(options)) return names;
      const chunk = ids.slice(index, index + CHUNK);
      if (chunk.length === 0) continue;
      const { data, error } = readResult(await client.from('profiles').select('id, full_name').in('id', chunk));
      if (error) throw error;
      for (const [id, name] of parseNames(data, 'id', 'full_name')) names.set(id, name);
    }
  } catch (error) {
    if (!isAbandoned(options)) reportFailure(OP.profiles, error, false);
  }
  return names;
}

async function loadCooldown(
  client: HomeFeedClient,
  userId: string,
  options: HomeFeedRequestOptions | undefined,
): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    if (isAbandoned(options) || !userId.trim()) return keys;
    const boundary = new Date(Date.now() - NUDGE_COOLDOWN_MS).toISOString();
    const { data, error } = readResult(
      await client
        .from('settlement_nudges')
        .select('receipt_id, recipient_id')
        .eq('sender_id', userId)
        .eq('delivery_status', 'sent')
        .gt('created_at', boundary),
    );
    if (error) throw error;
    if (!Array.isArray(data)) return keys;
    for (const row of data) {
      if (!row || typeof row !== 'object') continue;
      const record = row as { receipt_id?: unknown; recipient_id?: unknown };
      if (typeof record.receipt_id !== 'string' || typeof record.recipient_id !== 'string') continue;
      keys.add(`${record.receipt_id}:${record.recipient_id}`);
    }
  } catch (error) {
    if (!isAbandoned(options)) reportFailure(OP.nudges, error, false);
  }
  return keys;
}

function parseReceipts(value: unknown, options: HomeFeedRequestOptions | undefined): ReceiptRow[] {
  if (!Array.isArray(value)) return [];
  const rows: ReceiptRow[] = [];
  let dropped = false;
  for (const entry of value) {
    const row = parseReceipt(entry);
    if (row) rows.push(row);
    else dropped = true;
  }
  if (dropped && !isAbandoned(options)) logger.error('home', { operation: OP.receipts, code: 'ROW_FAILED' });
  return rows;
}

function parseReceipt(value: unknown): ReceiptRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id);
  const hostId = text(row.host_id);
  const createdAt = readTimestamp(row.created_at);
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

function readTimestamp(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? raw : '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
