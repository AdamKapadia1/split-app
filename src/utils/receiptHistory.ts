import { formatSmartDate } from '@/utils/formatSmartDate';
import { formatPence } from '@/utils/money';

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
  const leftTime = timestamp(left?.created_at);
  const rightTime = timestamp(right?.created_at);
  if (leftTime !== rightTime) return rightTime - leftTime;
  const leftId = left?.id ?? '';
  const rightId = right?.id ?? '';
  if (leftId === rightId) return 0;
  return leftId < rightId ? 1 : -1;
}

function timestamp(value: string | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}
