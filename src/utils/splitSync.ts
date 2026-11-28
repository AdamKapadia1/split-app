/**
 * Keeps a live split screen from painting a refetch that started
 * before the latest local tap has finished.
 */

export const SPLIT_SYNC_DEBOUNCE_MS = 200;

export const SPLIT_SYNC_EVENT = 'sync';

export type SplitSyncSignal = {
  share_token: string;
  event_type: string;
  ts: string;
};

export type SyncGate = {
  epoch: number;
  inFlight: number;
};

export function createSyncGate(): SyncGate {
  return { epoch: 0, inFlight: 0 };
}

export function beginLocalMutation(gate: SyncGate): number {
  gate.epoch += 1;
  gate.inFlight += 1;
  return gate.epoch;
}

/**
 * Bumps the epoch again once the local write settles so a snapshot captured
 * during the mutation cannot overwrite the mutation result.
 */
export function finishLocalMutation(gate: SyncGate): number {
  gate.inFlight = Math.max(0, gate.inFlight - 1);
  if (gate.inFlight === 0) gate.epoch += 1;
  return gate.epoch;
}

export function captureEpoch(gate: SyncGate): number {
  return gate.epoch;
}

export function mayApplyRemoteSnapshot(gate: SyncGate, capturedEpoch: number): boolean {
  return gate.inFlight === 0 && gate.epoch === capturedEpoch;
}

/**
 * Legacy token-keyed topic. The native host screen (useSplitRealtime) still
 * listens here, so the database keeps broadcasting to it for shipped builds.
 */
export function splitSyncTopic(shareToken: string): string {
  return `split-sync:${shareToken}`;
}

const RECEIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Receipt-keyed topic for the guest web page. The bearer share token never
 * appears in the topic name, Realtime logs, or browser inspectors.
 * Returns null for anything that is not a UUID.
 */
export function splitSyncReceiptTopic(receiptId: string | null | undefined): string | null {
  if (typeof receiptId !== 'string' || !RECEIPT_ID.test(receiptId)) return null;
  return `split-sync:${receiptId.toLowerCase()}`;
}

/** Realtime payload whitelist. Amounts and contact fields are dropped. */
export function splitSyncSignal(value: unknown): SplitSyncSignal | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const payload = row.payload && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : row;
  const shareToken = payload.share_token;
  const eventType = payload.event_type;
  const ts = payload.ts;
  if (typeof shareToken !== 'string' || shareToken.length < 20) return null;
  if (typeof eventType !== 'string' || eventType.length === 0 || eventType.length > 32) return null;
  if (typeof ts !== 'string' || ts.length === 0 || ts.length > 40) return null;
  return { share_token: shareToken, event_type: eventType, ts };
}
