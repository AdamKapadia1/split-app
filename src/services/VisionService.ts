export type ReceiptLineItem = {
  name: string;
  price: number;
};

export type ReceiptAnalysis = {
  items: ReceiptLineItem[];
  subtotal: number;
  tax: number;
  total: number;
};

export class VisionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionParseError';
  }
}

const SYSTEM_PROMPT =
  'You are a highly precise financial OCR engine. Analyze this receipt and extract the line items, subtotal, tax, and total. Return ONLY a raw, valid JSON object matching this exact schema: { "items": [{ "name": "string", "price": number }], "subtotal": number, "tax": number, "total": number }. Do not use markdown formatting blocks or conversational text.';

/**
 * Send a JPEG receipt to Anthropic and return the extracted ledger numbers.
 * `price`, `subtotal`, `tax`, and `total` are exact 2-decimal amounts.
 */
export async function analyzeReceipt(base64: string): Promise<ReceiptAnalysis> {
  const apiKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new VisionParseError('Missing EXPO_PUBLIC_ANTHROPIC_API_KEY.');
  }

  const image = base64.replace(/^data:image\/[a-z]+;base64,/i, '');
  if (image.trim().length === 0) {
    throw new VisionParseError('The captured photo did not include image data.');
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: image,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new VisionParseError(`Anthropic request failed (${response.status}).`);
    }

    const body: unknown = await response.json();
    const text = readModelText(body);
    const parsed: unknown = JSON.parse(extractJson(text));
    return parseAnalysis(parsed);
  } catch (error) {
    console.error('[VisionService] [analyzeReceipt] Error:', error);
    if (error instanceof VisionParseError) {
      throw error;
    }
    throw new VisionParseError(error instanceof Error ? error.message : 'Could not parse the receipt.');
  }
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] ?? text).trim();
}

function readModelText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.content)) {
    throw new VisionParseError('Anthropic response did not include content.');
  }

  const first = body.content[0];
  if (!isRecord(first) || typeof first.text !== 'string' || first.text.trim().length === 0) {
    throw new VisionParseError('Anthropic response did not include receipt JSON.');
  }

  return first.text;
}

function parseAnalysis(value: unknown): ReceiptAnalysis {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new VisionParseError('Receipt JSON did not match the expected schema.');
  }

  const items = value.items.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.trim().length === 0 || !isMoney(entry.price)) {
      throw new VisionParseError(`Item ${index + 1} was missing a name or price.`);
    }

    return { name: entry.name.trim(), price: entry.price };
  });

  if (!isMoney(value.subtotal) || !isMoney(value.tax) || !isMoney(value.total)) {
    throw new VisionParseError('Receipt totals were not numeric.');
  }

  return {
    items,
    subtotal: value.subtotal,
    tax: value.tax,
    total: value.total,
  };
}

function isMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
