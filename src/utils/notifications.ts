export const EXPO_PUSH_TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;
export const RECEIPT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const SENDER_WINDOW_MS = 60 * 60 * 1000;
export const SENDER_HOURLY_CAP = 10;
export const NUDGE_TITLE = 'Settlement reminder';

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function isExpoPushToken(value: string) {
  return EXPO_PUSH_TOKEN_PATTERN.test(value);
}

export function isReceiptUuid(value: string) {
  return RECEIPT_UUID_PATTERN.test(value);
}

/**
 * A settlement reminder may open one receipt. Anything that is not a bare UUID
 * — path traversal, extra segments, or a different notification type — is dropped.
 */
export function receiptIdFromNotificationData(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as { type?: unknown; receiptId?: unknown };
  if (record.type !== 'settlement_nudge') return null;
  if (typeof record.receiptId !== 'string') return null;
  const receiptId = record.receiptId.trim();
  if (receiptId !== record.receiptId) return null;
  if (!isReceiptUuid(receiptId)) return null;
  return receiptId;
}

export function nudgeCooldown(lastSentAtMs: number | null, nowMs: number) {
  if (lastSentAtMs == null || !Number.isFinite(lastSentAtMs) || !Number.isFinite(nowMs)) {
    return { active: false, nextAllowedAt: null as string | null };
  }
  const nextAllowedAtMs = lastSentAtMs + NUDGE_COOLDOWN_MS;
  if (nowMs < nextAllowedAtMs) {
    return { active: true, nextAllowedAt: new Date(nextAllowedAtMs).toISOString() };
  }
  return { active: false, nextAllowedAt: null as string | null };
}

/** Events at exactly `now - 1 hour` are outside the rolling window. */
export function senderWindowCount(createdAtMs: readonly number[], nowMs: number) {
  const start = nowMs - SENDER_WINDOW_MS;
  return createdAtMs.filter((createdAt) => Number.isFinite(createdAt) && createdAt > start && createdAt <= nowMs).length;
}

export function senderCapReached(createdAtMs: readonly number[], nowMs: number) {
  return senderWindowCount(createdAtMs, nowMs) >= SENDER_HOURLY_CAP;
}

export function senderFirstName(value: unknown) {
  if (typeof value !== 'string') return 'Someone';
  const token = value.trim().split(/\s+/)[0] ?? '';
  const cleaned = token.replace(/[^\p{L}'’-]/gu, '').slice(0, 24);
  return cleaned || 'Someone';
}

/** Lock-screen merchant text. Sort codes and account numbers are stripped. */
export function lockScreenMerchantName(value: unknown) {
  if (typeof value !== 'string') return 'your receipt';
  const cleaned = value
    .replace(/\b\d{2}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{6,8}\b/g, '')
    .replace(/[^\p{L}\p{N}&'., -]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned || 'your receipt';
}

export function formatPoundsFromPence(amountPence: number) {
  const minor = Math.trunc(amountPence);
  const abs = Math.abs(minor);
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function formatSettlementNudgeBody(input: {
  senderFirstName: string;
  amountPence: number;
  merchantName: string;
  hideAmounts: boolean;
}) {
  const name = senderFirstName(input.senderFirstName);
  if (input.hideAmounts) {
    return `${name} sent you a friendly settlement reminder`;
  }
  const merchant = lockScreenMerchantName(input.merchantName);
  return `${name} sent a friendly reminder for £${formatPoundsFromPence(input.amountPence)} (${merchant})`;
}

export function createTapId(now = Date.now(), entropy = Math.random().toString(36).slice(2, 10)) {
  return `${now.toString(36)}${entropy}`.replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
}

/** Stable for one button press, including a replay of that same press. */
export function createNudgeIdempotencyKey(receiptId: string, recipientId: string, tapId: string) {
  const key = `nudge:${receiptId}:${recipientId}:${tapId}`.replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 128);
  if (!isReceiptUuid(receiptId) || !isReceiptUuid(recipientId) || key.length < 8 || key.length > 128 || CONTROL_CHARS.test(key)) {
    throw new Error('Invalid nudge key');
  }
  return key;
}
