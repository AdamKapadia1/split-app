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
  'You are a raw data extraction API. Return ONLY a valid JSON object. Do not include markdown blocks (```json). Do not include introductory text. All prices and totals must be raw floats (e.g., 3.80) with NO currency symbols (£, $, etc). Schema: { "items": [{ "name": "string", "price": number }], "subtotal": number, "tax": number, "total": number }';

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
    const httpResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
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

    if (!httpResponse.ok) {
      throw new VisionParseError(`Anthropic request failed (${httpResponse.status}).`);
    }

    const response = (await httpResponse.json()) as AnthropicMessageResponse;
    const rawText = response.content[0].text;
    console.log("Raw LLM Output:", rawText);

    // Extract everything between the first '{' and the last '}'
    const startIndex = rawText.indexOf('{');
    const endIndex = rawText.lastIndexOf('}');

    if (startIndex === -1 || endIndex === -1) {
      throw new Error("No JSON object found in the LLM response.");
    }

    const cleanText = rawText.substring(startIndex, endIndex + 1);
    const parsedData = JSON.parse(cleanText);
    return parseAnalysis(parsedData);
  } catch (error) {
    console.error('[VisionService] [analyzeReceipt] Error:', error);
    if (error instanceof VisionParseError) {
      throw error;
    }
    throw new VisionParseError(error instanceof Error ? error.message : 'Could not parse the receipt.');
  }
}

type AnthropicMessageResponse = {
  content: { text: string }[];
};

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
