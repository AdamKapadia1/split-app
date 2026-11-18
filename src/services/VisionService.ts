const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2026-10-21';
const MODEL = 'claude-sonnet-5-5';

const SYSTEM_PROMPT =
  'You are a raw data extraction API. Return ONLY a valid JSON object. Do not include markdown blocks (```json). Do not include introductory text. All prices and totals must be raw floats (e.g., 3.80) with NO currency symbols (£, $, etc). Schema: { "items": [{ "name": "string", "price": number }], "subtotal": number, "tax": number, "total": number }';

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

type AnthropicContentBlock = {
  type?: string;
  text?: string;
};

type AnthropicMessage = {
  content?: AnthropicContentBlock[];
  error?: { message?: string };
};

export const VisionService = {
  async analyzeReceipt(base64: string): Promise<ReceiptAnalysis> {
    const apiKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Set EXPO_PUBLIC_ANTHROPIC_API_KEY in a .env file, then restart Expo.');
    }

    const cleanBase64 = base64.replace(/^data:image\/(?:jpeg|png|jpg);base64,/, '').replace(/\s/g, '');
    if (!cleanBase64) {
      throw new Error('The camera did not return image data.');
    }

    try {
      console.log('Sending receipt to Anthropic Vision API...');

      const response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1000,
          thinking: { type: 'between_tools' },
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
                    data: cleanBase64,
                  },
                },
                {
                  type: 'text',
                  text: 'Extract the line items, subtotal, tax, and total from this receipt.',
                },
              ],
            },
          ],
        }),
      });

      const responseText = await response.text();
      const data = parseResponseBody(responseText, response.status);

      if (!response.ok || data.error) {
        console.error('Anthropic API Error Payload:', responseText);
        throw new Error(data.error?.message || `HTTP error! status: ${response.status}`);
      }

      const rawText = textFromContent(data.content);
      console.log('Raw LLM Output:', rawText);

      const startIndex = rawText.indexOf('{');
      const endIndex = rawText.lastIndexOf('}');
      if (startIndex === -1 || endIndex === -1) {
        throw new Error('No JSON object found in the LLM response.');
      }

      return parseAnalysis(JSON.parse(rawText.substring(startIndex, endIndex + 1)));
    } catch (error) {
      console.error('Vision API Error:', error);
      throw error;
    }
  },
};

function parseResponseBody(responseText: string, status: number): AnthropicMessage {
  try {
    return JSON.parse(responseText) as AnthropicMessage;
  } catch {
    console.error('Anthropic response was not JSON:', status, responseText);
    throw new Error(`Anthropic API request failed (${status}).`);
  }
}

function textFromContent(content: AnthropicContentBlock[] | undefined) {
  const text = (content ?? [])
    .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
    .join('\n');

  return text || JSON.stringify(content ?? {});
}

function parseAnalysis(value: unknown): ReceiptAnalysis {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const items = Array.isArray(record.items)
    ? record.items.flatMap((item) => {
        if (!item || typeof item !== 'object') {
          return [];
        }
        const line = item as { name?: unknown; price?: unknown };
        const name = typeof line.name === 'string' ? line.name.trim() : '';
        if (!name) {
          return [];
        }
        return [{ name, price: asMoney(line.price) }];
      })
    : [];

  const subtotal = record.subtotal == null ? items.reduce((sum, item) => sum + item.price, 0) : asMoney(record.subtotal);
  const tax = asMoney(record.tax);
  const total = record.total == null ? asMoney(subtotal + tax) : asMoney(record.total);

  return { items, subtotal, tax, total };
}

function asMoney(value: unknown) {
  const number = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.round(number * 100) / 100;
}
