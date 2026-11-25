import { normalizeAccountNumber, normalizeSortCode, sanitizeReference } from './paymentLinks';

const HANDLE = /^[A-Za-z0-9._-]{2,64}$/;
const URL_PREFIX = /^(?:https?:\/\/)?(?:www\.)?(?:monzo\.me|revolut\.me)\//i;
const FASTER_REFERENCE_MAX = 18;

export type MonzoPayLink = {
  handle: string;
  url: string;
};

export type RevolutPayLink = {
  handle: string;
  url: string;
  copyText: string;
};

export type FasterPaymentDetails = {
  recipient: string;
  sortCodeDisplay: string;
  sortCodeDigits: string;
  accountNumber: string;
  reference: string;
  summary: string;
};

export type UkPaymentRails = {
  monzo: MonzoPayLink | null;
  revolut: RevolutPayLink | null;
  bank: FasterPaymentDetails | null;
};

/**
 * Strips a leading @, surrounding spaces, and a monzo.me / revolut.me prefix.
 * The result is a single path segment, or null when it is not a safe handle.
 */
export function normalizeUkHandle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().replace(URL_PREFIX, '').replace(/^@+/, '').trim();
  const segment = value.split(/[/?#]/)[0] ?? '';
  value = segment.trim();
  if (!HANDLE.test(value) || value.includes('..')) return null;
  return value;
}

/** True only for absolute https URLs. javascript:, http:, and relative paths fail. */
export function isHttpsUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.username.length === 0 && parsed.password.length === 0;
  } catch {
    return false;
  }
}

/**
 * Monzo.me payment link with a decimal amount and an optional note.
 * Returns null unless the handle is safe and the amount is at least 1p.
 */
export function buildMonzoPayUrl(
  rawHandle: string | null | undefined,
  amountPence: number,
  reference?: string,
): string | null {
  const handle = normalizeUkHandle(rawHandle);
  if (!handle) return null;
  if (!Number.isInteger(amountPence) || amountPence <= 0 || amountPence > 1_000_000) return null;
  const amount = (amountPence / 100).toFixed(2);
  const note = sanitizeReference(reference);
  let url = `https://monzo.me/${handle}/${amount}`;
  if (note.length > 0) url += `?d=${encodeURIComponent(note)}`;
  return isHttpsUrl(url) ? url : null;
}

/**
 * Revolut profile link. A pasted https://revolut.me URL is kept only when its
 * host and handle are safe. Amounts stay off the URL and go on the clipboard.
 */
export function buildRevolutPayUrl(raw: string | null | undefined): string | null {
  const fromLink = revolutUrl(raw);
  if (fromLink) return fromLink;
  const handle = normalizeUkHandle(raw);
  if (!handle) return null;
  const url = `https://revolut.me/${handle}`;
  return isHttpsUrl(url) ? url : null;
}

export function formatHandleAmountCopy(handle: string, amountLabel: string): string {
  const safe = normalizeUkHandle(handle);
  if (!safe) return amountLabel;
  return `@${safe}\n${amountLabel}`;
}

/** Six digits in, `XX-XX-XX` out. Anything else is null. */
export function formatUkSortCode(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const digits = normalizeSortCode(raw);
  if (!digits) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}`;
}

/** Digits to place on the clipboard for a sort code. */
export function sortCodeDigits(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  return normalizeSortCode(raw);
}

/** Eight-digit account number, spaces removed. */
export function ukAccountNumber(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  return normalizeAccountNumber(raw);
}

/**
 * Faster Payments reference: letters, numbers, and hyphens, at most 18 characters.
 * Shape is `VELOR-` plus a short source token.
 */
export function buildFasterPaymentReference(source: string): string {
  const body = (typeof source === 'string' ? source : '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, FASTER_REFERENCE_MAX - 'VELOR-'.length);
  const ref = `VELOR-${body.length > 0 ? body : 'BILL'}`;
  return ref.replace(/[^A-Z0-9-]/g, '').slice(0, FASTER_REFERENCE_MAX);
}

export function formatBankDetailsSummary(input: {
  recipient: string;
  sortCodeDisplay: string;
  accountNumber: string;
  amountLabel: string;
  reference: string;
}): string {
  return [
    `Recipient: ${input.recipient}`,
    `Sort Code: ${input.sortCodeDisplay}`,
    `Account Number: ${input.accountNumber}`,
    `Amount: ${input.amountLabel}`,
    `Reference: ${input.reference}`,
  ].join('\n');
}

export function resolveUkPaymentRails(input: {
  monzoHandle: string | null;
  revolutHandle: string | null;
  paymentLink?: string | null;
  bankAccountName: string | null;
  bankSortCode: string | null;
  bankAccountNumber: string | null;
  amountPence: number;
  amountLabel: string;
  referenceSource: string;
  monzoNote?: string;
}): UkPaymentRails {
  const monzoHandle = normalizeUkHandle(input.monzoHandle) ?? handleFromLink(input.paymentLink, 'monzo.me');
  const revolutHandle = normalizeUkHandle(input.revolutHandle) ?? handleFromLink(input.paymentLink, 'revolut.me');
  const revolutUrlValue = buildRevolutPayUrl(revolutHandle) ?? buildRevolutPayUrl(input.paymentLink);
  const reference = buildFasterPaymentReference(input.referenceSource);
  const monzoUrl = buildMonzoPayUrl(monzoHandle, input.amountPence, input.monzoNote ?? reference);

  const sortDisplay = formatUkSortCode(input.bankSortCode);
  const sortDigits = sortCodeDigits(input.bankSortCode);
  const account = ukAccountNumber(input.bankAccountNumber);
  const recipient = cleanRecipient(input.bankAccountName);
  const bank = sortDisplay && sortDigits && account && recipient
    ? {
        recipient,
        sortCodeDisplay: sortDisplay,
        sortCodeDigits: sortDigits,
        accountNumber: account,
        reference,
        summary: formatBankDetailsSummary({
          recipient,
          sortCodeDisplay: sortDisplay,
          accountNumber: account,
          amountLabel: input.amountLabel,
          reference,
        }),
      }
    : null;

  return {
    monzo: monzoHandle && monzoUrl ? { handle: monzoHandle, url: monzoUrl } : null,
    revolut: revolutHandle && revolutUrlValue
      ? { handle: revolutHandle, url: revolutUrlValue, copyText: formatHandleAmountCopy(revolutHandle, input.amountLabel) }
      : null,
    bank,
  };
}

/**
 * Clipboard write that survives iOS Safari and private-mode browsers.
 * Call it from the tap handler. Returns false when both strategies fail.
 */
export async function copyPlainText(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Safari rejects the async clipboard API once the gesture has expired.
    }
  }
  if (typeof document === 'undefined' || !document.body) return false;
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.focus();
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  document.body.removeChild(area);
  return copied;
}

function revolutUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.toLowerCase().startsWith('https://')) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (host !== 'revolut.me') return null;
  const handle = normalizeUkHandle(parsed.pathname.split('/').filter((part) => part.length > 0)[0] ?? '');
  if (!handle) return null;
  const url = `https://revolut.me/${handle}`;
  return isHttpsUrl(url) ? url : null;
}

function handleFromLink(raw: string | null | undefined, host: 'monzo.me' | 'revolut.me'): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const withScheme = /^https:\/\//i.test(trimmed) ? trimmed : '';
  if (!withScheme) return null;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.hostname.replace(/^www\./i, '').toLowerCase() !== host) return null;
  return normalizeUkHandle(parsed.pathname.split('/').filter((part) => part.length > 0)[0] ?? '');
}

function cleanRecipient(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 70) return null;
  return name;
}
