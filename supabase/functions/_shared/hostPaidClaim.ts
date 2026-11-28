// Kept local (not imported) so this file loads unchanged under Deno, tsc, and tsx.
const SHARE_PARTICIPANTS_TABLE = 'receipt_share_participants';

/**
 * The one-email-per-share claim on receipt_share_participants.host_notified_at.
 *
 * A claim writes a unique `claimedAt` timestamp only while the column is null.
 * A rollback clears the column only while it still holds that exact timestamp,
 * so a failed request can never wipe the marker of a concurrent request that
 * delivered successfully.
 */

type QueryResult = { data?: unknown; error: unknown };

export type ClaimFilter = PromiseLike<QueryResult> & {
  eq(column: string, value: string): ClaimFilter;
  is(column: string, value: null): ClaimFilter;
  select(columns: string): PromiseLike<QueryResult>;
};

export type HostPaidClaimClient = {
  from(table: string): {
    update(values: Record<string, unknown>): ClaimFilter;
  };
};

export type ClaimOutcome = 'claimed' | 'already_notified' | 'error';

export function newClaimTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}

export async function claimHostPaidEmail(
  client: HostPaidClaimClient,
  shareId: string,
  claimedAt: string,
): Promise<ClaimOutcome> {
  try {
    const result = await client
      .from(SHARE_PARTICIPANTS_TABLE)
      .update({ host_notified_at: claimedAt })
      .eq('id', shareId)
      .is('host_notified_at', null)
      .select('id');
    if (result.error) return 'error';
    const rows = Array.isArray(result.data) ? result.data : [];
    return rows.length > 0 ? 'claimed' : 'already_notified';
  } catch {
    return 'error';
  }
}

/** Returns false when the rollback write itself failed. */
export async function rollbackHostPaidClaim(
  client: HostPaidClaimClient,
  shareId: string,
  claimedAt: string,
): Promise<boolean> {
  try {
    const result = await client
      .from(SHARE_PARTICIPANTS_TABLE)
      .update({ host_notified_at: null })
      .eq('id', shareId)
      .eq('host_notified_at', claimedAt);
    return !result.error;
  } catch {
    return false;
  }
}
