import { formatSmartDate } from '@/utils/formatSmartDate';
import { formatPence } from '@/utils/money';

/** First paint of History. Keeps the ledger uncluttered before the member asks for more. */
export const HISTORY_PREVIEW_LIMIT = 5;

/** Pages after the preview. Large enough to fill a phone, small enough to stay cheap. */
export const HISTORY_PAGE_SIZE = 15;

/** Merchant search is a substring, not a document. Cap it before it hits PostgREST. */
export const HISTORY_SEARCH_MAX_LENGTH = 100;

/** Wait for a pause in typing before querying the ledger. Submit and chips skip this. */
export const HISTORY_SEARCH_DEBOUNCE_MS = 300;

/**
 * Group chip sent to the server.
 * `all` is the whole RLS-visible ledger. `ungrouped` is `group_id IS NULL`.
 * Any other value must be a canonical group UUID before it is queried.
 */
export type ReceiptHistoryGroupFilter = 'all' | 'ungrouped' | string;

export type ReceiptHistoryFilter = {
  searchQuery: string;
  groupFilter: ReceiptHistoryGroupFilter;
};

const GROUP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Trims, collapses internal whitespace, and caps the merchant query.
 * iOS smart quotes are folded to straight ASCII so they match the stored merchant name.
 * Whitespace-only input becomes an empty string so it does not count as a filter.
 */
export function normalizeHistorySearchQuery(raw: string): string {
  const ascii = raw
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  return ascii.trim().replace(/\s+/g, ' ').slice(0, HISTORY_SEARCH_MAX_LENGTH);
}

/**
 * Escapes SQL LIKE wildcards so the merchant pattern matches literally.
 * Backslash is escaped first so the slashes added for `%` and `_` stay escapes.
 */
export function escapeIlikePattern(query: string): string {
  return query.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** Canonical 8-4-4-4-12 hex UUID. Rejects sentinels and filter injection. */
export function isValidGroupUuid(value: string): boolean {
  return GROUP_UUID.test(value);
}

/** True when the ledger query is narrower than the unfiltered preview. */
export function isHistoryFiltered(filter: ReceiptHistoryFilter): boolean {
  return normalizeHistorySearchQuery(filter.searchQuery).length > 0 || filter.groupFilter !== 'all';
}

/** Unfiltered History stays a 5-row preview. An active search or chip loads a full page. */
export function getInitialHistoryLimit(filter: ReceiptHistoryFilter): number {
  return isHistoryFiltered(filter) ? HISTORY_PAGE_SIZE : HISTORY_PREVIEW_LIMIT;
}

/**
 * Drops a group chip the member no longer belongs to.
 * `all` and `ungrouped` are sentinels, not group ids, so they always survive.
 */
export function reconcileGroupFilter(
  currentFilter: ReceiptHistoryGroupFilter,
  availableGroupIds: readonly string[],
): ReceiptHistoryGroupFilter {
  if (currentFilter === 'all' || currentFilter === 'ungrouped') return currentFilter;
  return availableGroupIds.includes(currentFilter) ? currentFilter : 'all';
}

/**
 * Strict keyset position. `createdAt` is the row's `created_at`; `id` breaks ties.
 * Both are required so two receipts inserted in the same millisecond stay ordered.
 */
export type ReceiptHistoryCursor = {
  createdAt: string;
  id: string;
};

export type ReceiptHistoryPage<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor: ReceiptHistoryCursor | null;
};

export type HistoryGroupKey = 'all' | 'personal' | (string & {});

/** One ledger row. `total_minor` is integer pence, never a decimal pound amount. */
export type HistoryReceiptInput = {
  id: string;
  group_id: string | null;
  group_name?: string | null;
  merchant_name?: string | null;
  total_minor: number;
  created_at: string;
};

/** Ledger row rendered by History. `total_minor` is integer pence. */
export type ReceiptHistoryItem = HistoryReceiptInput & {
  restaurant_name: string | null;
};

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})?$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PostgREST `or` filter for the next page after `cursor`.
 * Values are allow-listed and quoted so a `.` or `,` inside a timestamp cannot
 * change the filter grammar.
 */
export function buildReceiptHistoryKeysetFilter(cursor: ReceiptHistoryCursor): string {
  if (typeof cursor?.createdAt !== 'string' || typeof cursor?.id !== 'string') {
    throw new Error('Invalid receipt history cursor.');
  }

  const createdAt = cursor.createdAt.trim();
  const id = cursor.id.trim();
  if (!CURSOR_TIMESTAMP.test(createdAt) || !CURSOR_ID.test(id)) {
    throw new Error('Invalid receipt history cursor.');
  }

  const createdAtValue = quotePostgrestValue(createdAt);
  const idValue = quotePostgrestValue(id);
  return `created_at.lt.${createdAtValue},and(created_at.eq.${createdAtValue},id.lt.${idValue})`;
}

/**
 * Turns a `limit + 1` read into a page. The extra row is only a "has more" signal,
 * so History never asks Postgres for an exact count.
 */
export function sliceLookaheadPage<T extends { id: string; created_at: string }>(
  rows: readonly T[],
  limit: number,
): ReceiptHistoryPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows.slice();
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

/**
 * Appends a page onto the ledger. A repeated id keeps the incoming copy.
 * The result is always `created_at DESC, id DESC`, matching the server order.
 */
export function mergePaginatedReceipts<T extends { id: string; created_at: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort(compareNewest);
}

/**
 * Drops History back to the 5-receipt cap without a network round trip.
 * When more rows exist, the cursor is the 5th row so the next page starts at row 6.
 */
export function collapseHistoryToPreview<T extends { id: string; created_at: string }>(
  items: readonly T[],
  currentHasMore: boolean,
): ReceiptHistoryPage<T> {
  const preview = items.slice(0, HISTORY_PREVIEW_LIMIT);
  const hasMore = currentHasMore || items.length > HISTORY_PREVIEW_LIMIT;
  const anchor = preview[HISTORY_PREVIEW_LIMIT - 1] ?? (hasMore ? preview[preview.length - 1] : undefined);
  return {
    items: preview,
    hasMore,
    nextCursor: hasMore && anchor ? { createdAt: anchor.created_at, id: anchor.id } : null,
  };
}

function quotePostgrestValue(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export type HistorySection<T extends HistoryReceiptInput = HistoryReceiptInput> = {
  key: string;
  groupId: string | null;
  title: string;
  subtotalMinor: number;
  data: T[];
};

export type HistoryLedger<T extends HistoryReceiptInput = HistoryReceiptInput> = {
  sections: HistorySection<T>[];
  filteredTotalMinor: number;
  filteredCount: number;
};

/**
 * Filters a receipt list by group and search text, then buckets it by group.
 * Subtotals are integer-pence additions of `total_minor` — no pound floats.
 */
export function filterAndGroupReceipts<T extends HistoryReceiptInput>({
  receipts,
  searchQuery,
  selectedGroupKey,
}: {
  receipts: readonly T[];
  searchQuery: string;
  selectedGroupKey: HistoryGroupKey;
}): HistoryLedger<T> {
  const query = searchQuery.trim().toLowerCase();
  const matched = receipts.filter((receipt) => matchesGroup(receipt, selectedGroupKey) && matchesSearch(receipt, query));

  const buckets = new Map<string, T[]>();
  for (const receipt of matched) {
    const key = receipt.group_id ?? 'personal';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(receipt);
    else buckets.set(key, [receipt]);
  }

  const sections: HistorySection<T>[] = [];
  let filteredTotalMinor = 0;

  for (const [key, bucket] of buckets) {
    const data = bucket.slice().sort(byNewest);
    const subtotalMinor = sumMinor(data);
    filteredTotalMinor += subtotalMinor;
    const groupId = data[0]?.group_id ?? null;
    const title = data[0]?.group_name?.trim() || 'Personal';
    sections.push({ key, groupId, title, subtotalMinor, data });
  }

  sections.sort((left, right) => byNewest(left.data[0], right.data[0]));

  return {
    sections,
    filteredTotalMinor,
    filteredCount: matched.length,
  };
}

function matchesGroup(receipt: HistoryReceiptInput, selectedGroupKey: HistoryGroupKey) {
  if (selectedGroupKey === 'all') return true;
  if (selectedGroupKey === 'personal') return receipt.group_id === null;
  return receipt.group_id === selectedGroupKey;
}

function matchesSearch(receipt: HistoryReceiptInput, query: string) {
  if (query.length === 0) return true;

  const merchant = receipt.merchant_name?.toLowerCase() ?? '';
  if (merchant.includes(query)) return true;

  const group = (receipt.group_name?.trim() || 'personal').toLowerCase();
  if (group.includes(query)) return true;

  const formatted = formatPence(receipt.total_minor).toLowerCase();
  const plain = formatted.replace(/£/g, '');
  if (formatted.includes(query) || plain.includes(query)) return true;

  const when = formatSmartDate(receipt.created_at).toLowerCase();
  return when.includes(query);
}

function sumMinor(receipts: readonly HistoryReceiptInput[]) {
  let total = 0;
  for (const receipt of receipts) {
    total += receipt.total_minor;
  }
  return total;
}

function byNewest(left: HistoryReceiptInput | undefined, right: HistoryReceiptInput | undefined) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return compareNewest(left, right);
}

function compareNewest<T extends { id: string; created_at: string }>(left: T, right: T) {
  const leftTime = timestamp(left.created_at);
  const rightTime = timestamp(right.created_at);
  if (leftTime !== rightTime) return rightTime - leftTime;
  if (left.id === right.id) return 0;
  return left.id < right.id ? 1 : -1;
}

function timestamp(value: string | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
