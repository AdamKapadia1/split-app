import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

const MAX_IMAGE_BASE64_CHARS = 6_800_000;
const SCAN_TIMEOUT_MS = 35_000;

export type ScannedReceiptItem = {
  name: string;
  price: number;
};

export type ScannedReceipt = {
  merchant_name: string | null;
  website: string | null;
  items: ScannedReceiptItem[];
  subtotal: number;
  tax: number;
  total: number;
};

export type ReceiptScanErrorCode =
  | 'RATE_LIMITED'
  | 'IMAGE_TOO_LARGE'
  | 'UNAUTHORIZED'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'INVALID_PAYLOAD'
  | 'CONFIG_ERROR';

const FILE_URI = /^(file|content|ph|assets-library):/i;

export class ReceiptScanError extends Error {
  readonly code: ReceiptScanErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: ReceiptScanErrorCode, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'ReceiptScanError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type ScanPayload = {
  error?: unknown;
  code?: unknown;
  retryAfterSeconds?: unknown;
  receipt?: unknown;
};

export const VisionService = {
  async analyzeReceipt(base64: string): Promise<ScannedReceipt> {
    if (!supabase) {
      throw new ReceiptScanError('CONFIG_ERROR', 'Receipt scanning is temporarily unavailable.');
    }

    const image = prepareImage(base64);
    const { data, error, response } = await supabase.functions.invoke<ScanPayload>('scan-receipt', {
      body: {
        imageBase64: image.imageBase64,
        mediaType: image.mediaType,
      },
      timeout: SCAN_TIMEOUT_MS,
    });

    if (error) {
      throw await scanError(error, response);
    }

    const receipt = normalizeReceipt(data?.receipt);
    if (!receipt) {
      throw new ReceiptScanError('UPSTREAM_ERROR', 'Could not read the line items. Please try again.');
    }
    return receipt;
  },
};

export function formatScanLimitMessage(retryAfterSeconds: number): string {
  const seconds = Math.max(0, Math.round(retryAfterSeconds));
  if (seconds <= 1) {
    return "You've reached your scan limit. Please try again in a moment.";
  }
  if (seconds < 60) {
    return `You've reached your scan limit. Please try again in ${seconds} seconds.`;
  }

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    const unit = minutes === 1 ? 'minute' : 'minutes';
    return `You've reached your scan limit. Please try again in ${minutes} ${unit}.`;
  }

  const hours = Math.ceil(minutes / 60);
  const unit = hours === 1 ? 'hour' : 'hours';
  return `You've reached your scan limit. Please try again in ${hours} ${unit}.`;
}

function prepareImage(image: string): { imageBase64: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' } {
  const trimmed = image.trim();
  if (FILE_URI.test(trimmed)) {
    throw new ReceiptScanError('INVALID_PAYLOAD', "Couldn't read this photo. Try retaking it.");
  }

  const dataUrl = trimmed.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([\s\S]+)$/i);
  let mediaType: 'image/jpeg' | 'image/png' | 'image/webp' = 'image/jpeg';
  let payload = trimmed;
  if (dataUrl?.[1] && dataUrl[2]) {
    const type = dataUrl[1].toLowerCase();
    mediaType = type === 'image/png' ? 'image/png' : type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    payload = dataUrl[2];
  } else {
    payload = trimmed.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  }

  const imageBase64 = payload.replace(/\s/g, '');
  if (!imageBase64) {
    throw new ReceiptScanError('INVALID_PAYLOAD', "Couldn't read this photo. Try retaking it.");
  }
  if (imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    throw new ReceiptScanError('IMAGE_TOO_LARGE', 'This image is too large to scan. Try retaking the photo.');
  }
  return { imageBase64, mediaType };
}

async function scanError(error: unknown, response: Response | undefined): Promise<ReceiptScanError> {
  if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) {
    return new ReceiptScanError('TIMEOUT', 'Receipt scan timed out. Please try again.');
  }

  const httpResponse = response ?? (error instanceof FunctionsHttpError ? asResponse(error.context) : undefined);
  const status = httpResponse?.status ?? 0;
  const body = await readBody(httpResponse);
  const code = typeof body?.code === 'string' ? body.code : '';

  if (status === 429 || code === 'RATE_LIMITED') {
    const retryAfterSeconds = nonNegativeNumber(body?.retryAfterSeconds);
    return new ReceiptScanError('RATE_LIMITED', formatScanLimitMessage(retryAfterSeconds), retryAfterSeconds);
  }
  if (status === 413 || code === 'IMAGE_TOO_LARGE') {
    return new ReceiptScanError('IMAGE_TOO_LARGE', 'This image is too large to scan. Try retaking the photo.');
  }
  if (status === 401 || code === 'UNAUTHORIZED') {
    return new ReceiptScanError('UNAUTHORIZED', 'Your session expired. Please sign in again.');
  }
  if (status === 504 || code === 'UPSTREAM_TIMEOUT') {
    return new ReceiptScanError('TIMEOUT', 'Receipt scan timed out. Please try again.');
  }
  if (status === 400 || code === 'INVALID_PAYLOAD') {
    return new ReceiptScanError('INVALID_PAYLOAD', "Couldn't read this photo. Try retaking it.");
  }
  return new ReceiptScanError('UPSTREAM_ERROR', 'Could not read the line items. Please try again.');
}

function asResponse(value: unknown): Response | undefined {
  return typeof Response !== 'undefined' && value instanceof Response ? value : undefined;
}

async function readBody(response: Response | undefined): Promise<ScanPayload | null> {
  if (!response) return null;
  try {
    const body = (await response.json()) as unknown;
    return body && typeof body === 'object' ? (body as ScanPayload) : null;
  } catch {
    return null;
  }
}

function normalizeReceipt(value: unknown): ScannedReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as {
    merchant_name?: unknown;
    restaurantName?: unknown;
    restaurant_name?: unknown;
    website?: unknown;
    items?: unknown;
    subtotal?: unknown;
    tax?: unknown;
    total?: unknown;
  };

  const items = Array.isArray(record.items)
    ? record.items.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const row = item as { name?: unknown; price?: unknown };
        const name = typeof row.name === 'string' ? row.name.trim() : '';
        if (!name) return [];
        return [{ name, price: asMoney(row.price) }];
      })
    : [];

  return {
    merchant_name: readMerchantName(record),
    website: typeof record.website === 'string' && record.website.trim() ? record.website.trim() : null,
    items,
    subtotal: asMoney(record.subtotal),
    tax: asMoney(record.tax),
    total: asMoney(record.total),
  };
}

function readMerchantName(parsed: { merchant_name?: unknown; restaurantName?: unknown; restaurant_name?: unknown }) {
  const raw = parsed.merchant_name ?? parsed.restaurantName ?? parsed.restaurant_name;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.toLowerCase() === 'null') return null;
  return name;
}

function asMoney(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100) / 100;
}

function nonNegativeNumber(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, number);
}
