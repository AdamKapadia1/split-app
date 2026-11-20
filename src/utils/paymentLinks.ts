export type PaymentLinkProvider = 'monzo' | 'revolut' | 'paypal';

export const ALLOWED_PAYMENT_HOSTS = new Set(['monzo.me', 'revolut.me', 'paypal.me']);

const PAYPAL_HANDLE = /^[A-Za-z0-9]{2,64}$/;
const UK_HANDLE = /^[A-Za-z0-9._-]{2,64}$/;
const MAX_AMOUNT_PENCE = 1_000_000;
const REFERENCE_LIMIT = 35;

const PROVIDER_PREFIX = /^(?:https?:\/\/)?(?:www\.)?(?:monzo\.me|revolut\.me|paypal\.me)\//i;

const MONZO_LIMIT_WARNING =
  'Monzo.me card payments are limited to £1–£100 for non-Monzo users. Use bank transfer if this fails.';
const REVOLUT_LIMIT_WARNING = 'Card payments via Revolut.me are capped at £250/week.';

/**
 * Turns a typed handle or a pasted provider URL into a safe path segment.
 * Anything that could change the host, path, or query is rejected.
 */
export function sanitizePaymentHandle(provider: PaymentLinkProvider, raw: string): string | null {
  if (typeof raw !== 'string') return null;

  let value = raw.trim().replace(PROVIDER_PREFIX, '').replace(/^@+/, '').trim();

  if (value.length === 0) return null;
  if (value.includes('..')) return null;
  if (/[/?#&\\\s]/.test(value)) return null;
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;
  if (/[^\u0000-\u007F]/.test(value)) return null;

  const pattern = provider === 'paypal' ? PAYPAL_HANDLE : UK_HANDLE;
  if (!pattern.test(value)) return null;
  return value;
}

/** Strips spaces and hyphens. Returns six ASCII digits, or null. */
export function normalizeSortCode(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^[0-9]{6}$/.test(digits)) return null;
  return digits;
}

/** Formats six digits as `XX-XX-XX`. */
export function formatSortCode(digits: string): string {
  if (!/^[0-9]{6}$/.test(digits)) {
    throw new Error('Sort code must be 6 digits.');
  }
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
}

/** Strips spaces. Returns eight ASCII digits, or null. */
export function normalizeAccountNumber(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\s/g, '');
  if (!/^[0-9]{8}$/.test(digits)) return null;
  return digits;
}

/** Shows the last four digits. The first four stay masked. */
export function maskAccountNumber(digits: string): string {
  if (!/^[0-9]{8}$/.test(digits)) {
    throw new Error('Account number must be 8 digits.');
  }
  return `••••${digits.slice(4)}`;
}

/**
 * A UK Faster Payments reference. Control characters and URL symbols are removed,
 * whitespace is collapsed, and the result is capped at 35 characters.
 */
export function sanitizeReference(raw?: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[/?#&=%\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, REFERENCE_LIMIT);
}

/** Card-scheme limits for Monzo.me and Revolut.me. PayPal has no in-app warning. */
export function getProviderLimitWarning(provider: PaymentLinkProvider, amountPence: number): string | null {
  if (!Number.isInteger(amountPence)) return null;
  if (provider === 'monzo' && (amountPence < 100 || amountPence > 10_000)) return MONZO_LIMIT_WARNING;
  if (provider === 'revolut' && amountPence > 25_000) return REVOLUT_LIMIT_WARNING;
  return null;
}

/**
 * Builds an https payment URL from integer pence.
 * The handle is sanitized again, and the finished URL must stay on an allow-listed host.
 */
export function buildPaymentUrl(
  provider: PaymentLinkProvider,
  handle: string,
  amountPence: number,
  reference?: string,
): string {
  if (!Number.isInteger(amountPence) || amountPence <= 0 || amountPence > MAX_AMOUNT_PENCE) {
    throw new Error('Amount must be a whole number of pence from 1 to 1000000.');
  }

  const safeHandle = sanitizePaymentHandle(provider, handle);
  if (!safeHandle) {
    throw new Error('Payment handle is not valid.');
  }

  const amount = (amountPence / 100).toFixed(2);
  const note = sanitizeReference(reference);
  let url: string;

  if (provider === 'monzo') {
    url = `https://monzo.me/${safeHandle}/${amount}`;
    if (note.length > 0) url += `?d=${encodeURIComponent(note)}`;
  } else if (provider === 'revolut') {
    url = `https://revolut.me/${safeHandle}?amount=${amount}&currency=GBP`;
    if (note.length > 0) url += `&note=${encodeURIComponent(note)}`;
  } else {
    url = `https://paypal.me/${safeHandle}/${amount}GBP`;
  }

  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !ALLOWED_PAYMENT_HOSTS.has(parsed.hostname)) {
    throw new Error('Payment URL is not allowed.');
  }
  return url;
}
