import { VisionService } from '@/services/VisionService';

export type ReceiptItem = {
  quantity: number;
  name: string;
  amount: number;
};

export type ParsedReceipt = {
  restaurant_name?: string | null;
  website?: string | null;
  items: ReceiptItem[];
  subtotal: number;
  serviceCharge: number;
  total: number;
  currency: string;
};

export async function parseReceiptImage(image: string): Promise<ParsedReceipt> {
  if (/^(file|content|ph|assets-library):/i.test(image)) {
    throw new Error("Couldn't read this photo.");
  }

  const scanned = await VisionService.analyzeReceipt(image);
  return {
    restaurant_name: scanned.merchant_name,
    website: scanned.website,
    items: scanned.items.map((item) => ({
      quantity: 1,
      name: item.name,
      amount: item.price,
    })),
    subtotal: scanned.subtotal,
    serviceCharge: 0,
    total: scanned.total,
    currency: 'GBP',
  };
}

export function parseReceiptParam(value: string | undefined): ParsedReceipt | null {
  if (!value) {
    return null;
  }

  try {
    return parseReceiptJson(value);
  } catch {
    return null;
  }
}

function parseReceiptJson(text: string): ParsedReceipt {
  const json = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = json.indexOf('{');
  const end = json.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error("Couldn't read this receipt.");
  }

  const parsed = JSON.parse(json.slice(start, end + 1)) as {
    restaurant_name?: unknown;
    website?: unknown;
    items?: unknown;
    subtotal?: unknown;
    serviceCharge?: unknown;
    total?: unknown;
    currency?: unknown;
  };

  const items = Array.isArray(parsed.items)
    ? parsed.items.flatMap((item) => {
        if (!item || typeof item !== 'object') {
          return [];
        }
        const record = item as { quantity?: unknown; name?: unknown; amount?: unknown };
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        if (!name) {
          return [];
        }
        const quantity = Math.max(1, Math.round(asNumber(record.quantity) || 1));
        return [{ quantity, name, amount: asMoney(record.amount) }];
      })
    : [];

  const subtotal = parsed.subtotal == null ? items.reduce((sum, item) => sum + item.amount, 0) : asMoney(parsed.subtotal);
  const serviceCharge = asMoney(parsed.serviceCharge);
  const total = parsed.total == null ? asMoney(subtotal + serviceCharge) : asMoney(parsed.total);
  const currency = typeof parsed.currency === 'string' && parsed.currency.trim() ? parsed.currency.trim().toUpperCase() : 'GBP';
  
  const restaurant_name = typeof parsed.restaurant_name === 'string' ? parsed.restaurant_name.trim() : null;
  const website = typeof parsed.website === 'string' ? parsed.website.trim() : null;

  return {
    restaurant_name,
    website,
    items,
    subtotal: asMoney(subtotal),
    serviceCharge,
    total,
    currency,
  };
}

function asNumber(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function asMoney(value: unknown) {
  return Math.round(asNumber(value) * 100) / 100;
}