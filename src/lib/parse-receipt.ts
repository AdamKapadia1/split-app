import { Platform } from 'react-native';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2026-10-21';
const MODEL = 'claude-sonnet-5-5';

export type ReceiptItem = {
  quantity: number;
  name: string;
  amount: number;
};

export type ParsedReceipt = {
  items: ReceiptItem[];
  subtotal: number;
  serviceCharge: number;
  total: number;
  currency: string;
};

type AnthropicMessage = {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
};

export async function parseReceiptImage(image: string): Promise<ParsedReceipt> {
  const apiKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('Set EXPO_PUBLIC_ANTHROPIC_API_KEY in a .env file, then restart Expo.');
  }

  const data = normalizeImage(image).replace(/^data:image\/[a-z]+;base64,/, '');
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      Authorization: `Bearer ${apiKey}`,
      'x-api-key': apiKey,
      ...(Platform.OS === 'web' ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system:
        'You extract structured data from receipt photos. Reply with JSON only, with no markdown.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data,
              },
            },
            {
              type: 'text',
              text: [
                'Read this receipt and return JSON with this shape:',
                '{',
                '  "items": [{ "quantity": number, "name": string, "amount": number }],',
                '  "subtotal": number,',
                '  "serviceCharge": number,',
                '  "total": number,',
                '  "currency": string',
                '}',
                'amount is the line total, not the unit price. quantity is how many of that item were bought.',
                'Use an ISO currency code. Use 0 when service charge is not printed.',
                'If subtotal or total are missing, calculate them from the line items.',
              ].join('\n'),
            },
          ],
        },
      ],
    }),
  });

  const body = (await response.json().catch(() => null)) as AnthropicMessage | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `Couldn't read this receipt (${response.status}).`);
  }

  const text = body?.content?.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : [])).join('\n');
  if (!text) {
    throw new Error("Couldn't read this receipt.");
  }

  return parseReceiptJson(text);
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

function normalizeImage(image: string) {
  if (/^(file|content|ph|assets-library):/i.test(image)) {
    throw new Error("Couldn't read this photo.");
  }

  return image.replace(/\s/g, '');
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

  return {
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
