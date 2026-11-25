/**
 * Penny-exact UK receipt shares for the no-account split link.
 * Item prices are already VAT-inclusive, so VAT is never added again.
 * Discretionary service (and any other gap up to the printed total) is
 * spread in proportion to claimed item subtotals.
 * Every allocator returns whole pence. Unclaimed item pence stay unclaimed.
 * When nobody has claimed anything, service stays unclaimed too.
 */

export function toPence(amount: number): number {
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

export function lineTotalPence(unitPrice: number, quantity: number): number {
  const count = Number.isFinite(quantity) ? Math.max(1, Math.round(quantity)) : 1;
  return toPence(unitPrice) * count;
}

/**
 * Splits `totalPence` across ids sorted lexicographically.
 * Each person receives floor(total / n), then the remainder pennies
 * go one at a time from the front of that list.
 */
export function splitEquallyDeterministic(totalPence: number, participantIds: readonly string[]): Record<string, number> {
  const ids = uniqueSorted(participantIds);
  const shares: Record<string, number> = {};
  if (ids.length === 0) return shares;

  const total = Math.max(0, Math.round(totalPence));
  const base = Math.floor(total / ids.length);
  let remainder = total - base * ids.length;
  for (const id of ids) {
    const bonus = remainder > 0 ? 1 : 0;
    if (bonus === 1) remainder -= 1;
    shares[id] = base + bonus;
  }
  return shares;
}

/**
 * Largest-remainder allocation. Zero weights receive nothing while anyone
 * has a claimed subtotal. If every weight is zero, the whole amount stays
 * unallocated (the returned shares are zero).
 */
export function allocateLargestRemainder(totalPence: number, weights: Record<string, number>): Record<string, number> {
  const ids = uniqueSorted(Object.keys(weights));
  const shares: Record<string, number> = {};
  for (const id of ids) shares[id] = 0;
  if (ids.length === 0) return shares;

  const total = Math.max(0, Math.round(totalPence));
  if (total === 0) return shares;

  const safe: Record<string, number> = {};
  for (const id of ids) safe[id] = Math.max(0, Math.round(weights[id] ?? 0));
  const weightSum = ids.reduce((sum, id) => sum + safe[id], 0);
  if (weightSum <= 0) return shares;

  const weightSumBig = BigInt(weightSum);
  const totalBig = BigInt(total);
  const rows = ids.map((id) => {
    const product = totalBig * BigInt(safe[id]);
    return {
      id,
      base: Number(product / weightSumBig),
      fraction: Number(product % weightSumBig),
    };
  });

  let leftover = total - rows.reduce((sum, row) => sum + row.base, 0);
  const ranked = [...rows].sort((left, right) => {
    if (right.fraction !== left.fraction) return right.fraction - left.fraction;
    return compareLex(left.id, right.id);
  });

  for (const row of rows) shares[row.id] = row.base;
  for (const row of ranked) {
    if (leftover <= 0) break;
    shares[row.id] += 1;
    leftover -= 1;
  }
  return shares;
}

export type SharedSplitItem = {
  id: string;
  pricePence: number;
};

export type SharedSplitClaim = {
  itemId: string;
  participantId: string;
};

export type SharedSplitResult = {
  itemsSubtotal: Record<string, number>;
  serviceCharge: Record<string, number>;
  amountOwed: Record<string, number>;
  unclaimedPence: number;
};

/**
 * Participant totals plus unclaimed pence equal `totalPence`.
 * `serviceChargePence` is the printed discretionary service, shown on its
 * own line. The owed total uses the gap between the printed total and the
 * sum of the lines, which is zero when VAT is already inside those lines.
 */
export function reconcileSharedBill(input: {
  items: readonly SharedSplitItem[];
  claims: readonly SharedSplitClaim[];
  participantIds: readonly string[];
  totalPence: number;
  serviceChargePence: number;
}): SharedSplitResult {
  const participantIds = uniqueSorted(input.participantIds);
  const itemsSubtotal: Record<string, number> = {};
  for (const id of participantIds) itemsSubtotal[id] = 0;

  const claimsByItem = new Map<string, string[]>();
  for (const claim of input.claims) {
    const list = claimsByItem.get(claim.itemId) ?? [];
    if (!list.includes(claim.participantId)) list.push(claim.participantId);
    claimsByItem.set(claim.itemId, list);
  }

  let linesPence = 0;
  for (const item of input.items) {
    const price = Math.max(0, Math.round(item.pricePence));
    linesPence += price;
    const piece = splitEquallyDeterministic(price, claimsByItem.get(item.id) ?? []);
    for (const [participantId, amount] of Object.entries(piece)) {
      itemsSubtotal[participantId] = (itemsSubtotal[participantId] ?? 0) + amount;
    }
  }

  const totalPence = Math.max(0, Math.round(input.totalPence));
  const gap = Math.max(0, totalPence - linesPence);
  // Fee is service and tip already inside the printed total. Capping it at the
  // gap keeps VAT-inclusive item prices from being taxed a second time.
  const declaredFee = Math.max(0, Math.round(input.serviceChargePence));
  const servicePool = Math.min(declaredFee, gap);
  const extrasShare = allocateLargestRemainder(gap, itemsSubtotal);
  const serviceCharge = allocateLargestRemainder(servicePool, itemsSubtotal);

  const amountOwed: Record<string, number> = {};
  for (const id of participantIds) {
    amountOwed[id] = (itemsSubtotal[id] ?? 0) + (extrasShare[id] ?? 0);
  }
  for (const id of Object.keys(itemsSubtotal)) {
    if (amountOwed[id] === undefined) {
      amountOwed[id] = (itemsSubtotal[id] ?? 0) + (extrasShare[id] ?? 0);
    }
  }

  const assigned = Object.values(amountOwed).reduce((sum, amount) => sum + amount, 0);
  return {
    itemsSubtotal,
    serviceCharge,
    amountOwed,
    unclaimedPence: totalPence - assigned,
  };
}

function uniqueSorted(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort(compareLex);
}

function compareLex(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
