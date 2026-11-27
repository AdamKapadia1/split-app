/**
 * Exact-amount Monzo.me and Revolut.me links.
 * Amounts are integer pence. Every URL is parsed after it is built and must
 * stay on https://monzo.me or https://revolut.me.
 */

export type PayoutLinkProvider = 'monzo' | 'revolut';

export type HandleValidationResult =
  | { valid: true; handle: string | null }
  | { valid: false; handle: null; error: string };

export const PAYOUT_LINK_HOSTS = ['monzo.me', 'revolut.me'] as const;

const HANDLE = /^[A-Za-z0-9._-]{2,64}$/;
const PROVIDER_PREFIX = /^(?:https?:\/\/)?(?:www\.)?(?:monzo\.me|revolut\.me)\//i;
const NOTE_LIMIT = 35;
const MAX_AMOUNT_PENCE = 1_000_000;

const MONZO_LIMIT_WARNING =
  'Monzo.me card payments are limited to £1–£100 for non-Monzo users. Use bank transfer if this fails.';
const REVOLUT_LIMIT_WARNING = 'Card payments via Revolut.me are capped at £250/week.';

/** Blank means the host has not set this rail. Anything else must be one safe path segment. */
export function validatePaymentHandle(raw: string | null | undefined): HandleValidationResult {
  if (raw == null) return { valid: true, handle: null };
  if (typeof raw !== 'string') {
    return { valid: false, handle: null, error: 'Payment handle must be text.' };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) return { valid: true, handle: null };

  const value = trimmed.replace(PROVIDER_PREFIX, '').replace(/^@+/, '').trim();

  if (value.length === 0 || value.includes('..')) {
    return { valid: false, handle: null, error: 'Payment handle is not valid.' };
  }
  if (/[\u0000-\u001F\u007F]/.test(value) || /[^\u0000-\u007F]/.test(value)) {
    return { valid: false, handle: null, error: 'Payment handle is not valid.' };
  }
  if (/[/?#&\\\s]/.test(value) || !HANDLE.test(value)) {
    return { valid: false, handle: null, error: 'Payment handle is not valid.' };
  }
  return { valid: true, handle: value };
}

/** Pounds to integer pence. `12.5` becomes `1250`. */
export function amountToPence(amount: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new Error('Amount must be a finite number of pounds.');
  }
  return Math.round(amount * 100);
}

/** Two decimal places. `1250` becomes `12.50`. */
export function formatPoundsFromPence(amountPence: number): string {
  assertAmountPence(amountPence);
  return (amountPence / 100).toFixed(2);
}

export function providerLimitWarning(provider: PayoutLinkProvider, amountPence: number): string | null {
  if (!Number.isInteger(amountPence)) return null;
  if (provider === 'monzo' && (amountPence < 100 || amountPence > 10_000)) return MONZO_LIMIT_WARNING;
  if (provider === 'revolut' && amountPence > 25_000) return REVOLUT_LIMIT_WARNING;
  return null;
}

/** Faster Payments / payment-note text. Control characters and URL symbols are removed. */
export function sanitizePaymentNote(raw?: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[/?#&=%\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_LIMIT);
}

/**
 * Profile URL with no amount.
 * The handle is validated again, then the host is checked.
 */
export function buildProfilePaymentUrl(provider: PayoutLinkProvider, rawHandle: string): string {
  const handle = requireHandle(rawHandle);
  const url = `https://${provider}.me/${handle}`;
  return assertAllowlistedPaymentUrl(url, provider);
}

/**
 * Exact-amount https URL.
 * Monzo: `https://monzo.me/{handle}/{pounds}` with an optional `d` note.
 * Revolut: `https://revolut.me/{handle}?amount={pounds}&currency=GBP`.
 */
export function buildExactAmountPaymentUrl(
  provider: PayoutLinkProvider,
  rawHandle: string,
  amountPence: number,
  reference?: string,
): string {
  const handle = requireHandle(rawHandle);
  const amount = formatPoundsFromPence(amountPence);
  const note = sanitizePaymentNote(reference);
  let url: string;

  if (provider === 'monzo') {
    url = `https://monzo.me/${handle}/${amount}`;
    if (note.length > 0) url += `?d=${encodeURIComponent(note)}`;
  } else {
    url = `https://revolut.me/${handle}?amount=${amount}&currency=GBP`;
    if (note.length > 0) url += `&note=${encodeURIComponent(note)}`;
  }

  return assertAllowlistedPaymentUrl(url, provider);
}

function requireHandle(rawHandle: string): string {
  const result = validatePaymentHandle(rawHandle);
  if (!result.valid || result.handle == null) {
    throw new Error('Payment handle is not valid.');
  }
  return result.handle;
}

function assertAmountPence(amountPence: number): void {
  if (!Number.isInteger(amountPence) || amountPence <= 0 || amountPence > MAX_AMOUNT_PENCE) {
    throw new Error('Amount must be a whole number of pence from 1 to 1000000.');
  }
}

/** Rejects any protocol or host other than https on monzo.me or revolut.me. */
export function assertAllowlistedPaymentUrl(url: string, provider: PayoutLinkProvider): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Payment URL is not allowed.');
  }

  const expectedHost = provider === 'monzo' ? 'monzo.me' : 'revolut.me';
  if (parsed.protocol !== 'https:' || parsed.hostname !== expectedHost) {
    throw new Error('Payment URL is not allowed.');
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error('Payment URL is not allowed.');
  }
  if (!PAYOUT_LINK_HOSTS.includes(parsed.hostname as (typeof PAYOUT_LINK_HOSTS)[number])) {
    throw new Error('Payment URL is not allowed.');
  }
  return url;
}
