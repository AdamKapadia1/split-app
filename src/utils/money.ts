/**
 * Integer-pence money helpers.
 * Every share is a whole number of minor units, and every allocator returns
 * shares that add back to the exact total they were given.
 */

export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

/**
 * Splits `totalMinor` across `userIds` so the shares add up to that total.
 * Ids are sorted lexicographically, then leftover pennies are handed out
 * one per person from the front of that list.
 */
export function allocateEqually(totalMinor: number, userIds: string[]): Record<string, number> {
  const ids = uniqueSorted(userIds);
  const shares: Record<string, number> = {};
  if (ids.length === 0) return shares;

  const total = Math.round(totalMinor);
  const base = Math.floor(total / ids.length);
  let remainder = total - base * ids.length;

  for (const id of ids) {
    const bonus = remainder > 0 ? 1 : 0;
    if (bonus === 1) remainder -= 1;
    shares[id] = base + bonus;
  }

  return shares;
}

export type AllocatableItem = {
  id: string;
  priceMinor: number;
  assignedUserIds: string[];
};

/**
 * Gives each item's pence to the people assigned to it, then spreads
 * `extrasMinor` (tax, service, and tip) in proportion to those subtotals.
 * When nobody has a subtotal yet, the extras are split equally instead.
 * Assigned item pence plus the extras always equal the returned shares.
 */
export function allocateByItems(
  items: AllocatableItem[],
  extrasMinor: number,
  participantUserIds: string[],
): Record<string, number> {
  const participants = uniqueSorted(participantUserIds);
  const shares: Record<string, number> = {};
  for (const id of participants) shares[id] = 0;

  for (const item of items) {
    const piece = allocateEqually(item.priceMinor, item.assignedUserIds);
    for (const [userId, amount] of Object.entries(piece)) {
      shares[userId] = (shares[userId] ?? 0) + amount;
    }
  }

  const weights: Record<string, number> = {};
  for (const id of participants) weights[id] = shares[id] ?? 0;

  const extras = allocateByWeights(extrasMinor, participants, weights);
  for (const id of participants) {
    shares[id] = (shares[id] ?? 0) + (extras[id] ?? 0);
  }

  return shares;
}

/**
 * Pence still to share on top of the line items.
 * Returns 0 when those lines already add up to the bill, so a tax figure
 * that is included in the prices is not added a second time.
 */
export function extrasMinor(lineItemsMinor: number, totalMinor: number): number {
  return Math.max(0, Math.round(totalMinor) - Math.round(lineItemsMinor));
}

/** Formats integer pence as `£X.XX` without going back through floating point. */
export function formatPence(amountMinor: number): string {
  const minor = Math.round(amountMinor);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}£${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function allocateByWeights(totalMinor: number, userIds: string[], weights: Record<string, number>): Record<string, number> {
  const ids = uniqueSorted(userIds);
  if (ids.length === 0) return {};

  const total = Math.round(totalMinor);
  if (total < 0) {
    const flipped = allocateByWeights(-total, ids, weights);
    return Object.fromEntries(ids.map((id) => [id, -(flipped[id] ?? 0)]));
  }

  const safeWeights: Record<string, number> = {};
  for (const id of ids) safeWeights[id] = Math.max(0, Math.round(weights[id] ?? 0));
  const weightSum = ids.reduce((sum, id) => sum + safeWeights[id], 0);
  if (weightSum <= 0) return allocateEqually(total, ids);

  const weightSumBig = BigInt(weightSum);
  const totalBig = BigInt(total);
  const rows = ids.map((id) => {
    const product = totalBig * BigInt(safeWeights[id]);
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

  const shares: Record<string, number> = {};
  for (const row of rows) shares[row.id] = row.base;
  for (const row of ranked) {
    if (leftover <= 0) break;
    shares[row.id] += 1;
    leftover -= 1;
  }

  return shares;
}

function uniqueSorted(userIds: string[]): string[] {
  return [...new Set(userIds)].sort(compareLex);
}

function compareLex(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
