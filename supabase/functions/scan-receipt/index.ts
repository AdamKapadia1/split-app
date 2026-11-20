import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.119.0';

const MODEL = 'claude-sonnet-5-5';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_IMAGE_BASE64_CHARS = 6_800_000;
const UPSTREAM_TIMEOUT_MS = 25_000;
const HOURLY_LIMIT = 10;
const DAILY_LIMIT = 30;

const RECEIPT_SYSTEM_PROMPT =
  'You are a raw data extraction API. Return ONLY a valid JSON object. Do not include markdown blocks. All prices and totals must be raw floats (e.g., 3.80) with NO currency symbols. CRITICAL: Read the receipt strictly from top to bottom, line by line. You MUST preserve the exact original layout order of the items. merchant_name: look at the top logo, header, address block, or footer for the business name. Clean it into a readable display name (for example, convert "MOLLIES MOTEL & DINER LTD #04" to "Mollie\'s", or "TESCO STORES 2314" to "Tesco"). Return null only when no business name is visible at all. Schema: { "merchant_name": string | null, "website": string | null, "items": [{ "name": "string", "price": number }], "subtotal": number, "tax": number, "total": number }';

const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type MediaType = 'image/jpeg' | 'image/png' | 'image/webp';

type QuotaDecision = {
  allowed: boolean;
  reason: string | null;
  retry_after_seconds: number;
  hourly_remaining: number;
  daily_remaining: number;
};

type AuditStatus = 'success' | 'rate_limited' | 'invalid_payload' | 'upstream_error' | 'timeout';

type ScannedReceipt = {
  merchant_name: string | null;
  website: string | null;
  items: { name: string; price: number }[];
  subtotal: number;
  tax: number;
  total: number;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const missing = [
    !anthropicKey ? 'ANTHROPIC_API_KEY' : null,
    !supabaseUrl ? 'SUPABASE_URL' : null,
    !anonKey ? 'SUPABASE_ANON_KEY' : null,
    !serviceRoleKey ? 'SUPABASE_SERVICE_ROLE_KEY' : null,
  ].filter((name): name is string => Boolean(name));

  if (missing.length > 0) {
    console.error(`[scan-receipt] missing configuration: ${missing.join(', ')}`);
    return json(500, { error: 'Scanner service not configured', code: 'CONFIG_ERROR' });
  }

  const token = bearerToken(req.headers.get('Authorization'));
  if (!token) {
    return json(401, { error: 'Authentication required', code: 'UNAUTHORIZED' });
  }

  const userClient = createClient(supabaseUrl!, anonKey!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: authError } = await userClient.auth.getUser(token);
  const user = userData?.user;
  if (authError || !user) {
    return json(401, { error: 'Authentication required', code: 'UNAUTHORIZED' });
  }

  const admin = createClient(supabaseUrl!, serviceRoleKey!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    await writeAudit(admin, { user_id: user.id, status: 'invalid_payload', error_code: 'INVALID_PAYLOAD' });
    return json(400, { error: 'Invalid scan payload', code: 'INVALID_PAYLOAD' });
  }

  const image = readImage(payload);
  if (!image.ok) {
    const status = image.reason === 'too_large' ? 413 : 400;
    const code = image.reason === 'too_large' ? 'IMAGE_TOO_LARGE' : 'INVALID_PAYLOAD';
    await writeAudit(admin, { user_id: user.id, status: 'invalid_payload', error_code: code });
    return json(status, {
      error: image.reason === 'too_large' ? 'Image is too large' : 'Invalid scan payload',
      code,
    });
  }

  const { data: quotaData, error: quotaError } = await admin.rpc('check_and_increment_scan_quota', {
    p_user_id: user.id,
    p_hourly_limit: HOURLY_LIMIT,
    p_daily_limit: DAILY_LIMIT,
  });
  const quota = readQuota(quotaData);
  if (quotaError || !quota) {
    console.error('[scan-receipt] quota check failed', quotaError?.message ?? 'empty quota');
    return json(500, { error: 'Scanner service not configured', code: 'CONFIG_ERROR' });
  }

  if (!quota.allowed) {
    await writeAudit(admin, {
      user_id: user.id,
      status: 'rate_limited',
      error_code: quota.reason ?? 'RATE_LIMITED',
    });
    return json(
      429,
      {
        error: 'Scan limit reached',
        code: 'RATE_LIMITED',
        retryAfterSeconds: quota.retry_after_seconds,
        reason: quota.reason,
      },
      { 'Retry-After': String(quota.retry_after_seconds) },
    );
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicKey!,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        thinking: { type: 'between_tools' },
        system: RECEIPT_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.mediaType,
                  data: image.imageBase64,
                },
              },
            ],
          },
        ],
      }),
    });

    const latencyMs = Date.now() - started;
    const upstreamBody = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      console.error('[scan-receipt] upstream status', upstream.status);
      await writeAudit(admin, {
        user_id: user.id,
        status: 'upstream_error',
        model: MODEL,
        latency_ms: latencyMs,
        error_code: `anthropic_${upstream.status}`,
      });
      return json(502, { error: 'Receipt scan failed', code: 'UPSTREAM_ERROR' });
    }

    const parsed = parseModelReceipt(upstreamBody);
    if (!parsed) {
      await writeAudit(admin, {
        user_id: user.id,
        status: 'upstream_error',
        model: readModel(upstreamBody),
        input_tokens: readTokens(upstreamBody, 'input_tokens'),
        output_tokens: readTokens(upstreamBody, 'output_tokens'),
        latency_ms: latencyMs,
        error_code: 'INVALID_MODEL_JSON',
      });
      return json(502, { error: 'Receipt scan failed', code: 'UPSTREAM_ERROR' });
    }

    await writeAudit(admin, {
      user_id: user.id,
      status: 'success',
      model: readModel(upstreamBody) ?? MODEL,
      input_tokens: readTokens(upstreamBody, 'input_tokens'),
      output_tokens: readTokens(upstreamBody, 'output_tokens'),
      latency_ms: latencyMs,
    });

    return json(200, {
      receipt: parsed,
      quota: {
        hourlyRemaining: quota.hourly_remaining,
        dailyRemaining: quota.daily_remaining,
      },
    });
  } catch (error) {
    const latencyMs = Date.now() - started;
    if (isAbortError(error)) {
      console.error('[scan-receipt] upstream timeout');
      await writeAudit(admin, {
        user_id: user.id,
        status: 'timeout',
        model: MODEL,
        latency_ms: latencyMs,
        error_code: 'UPSTREAM_TIMEOUT',
      });
      return json(504, { error: 'Receipt scan timed out', code: 'UPSTREAM_TIMEOUT' });
    }

    console.error('[scan-receipt] upstream request failed');
    await writeAudit(admin, {
      user_id: user.id,
      status: 'upstream_error',
      model: MODEL,
      latency_ms: latencyMs,
      error_code: 'UPSTREAM_ERROR',
    });
    return json(502, { error: 'Receipt scan failed', code: 'UPSTREAM_ERROR' });
  } finally {
    clearTimeout(timer);
  }
});

function json(status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function readImage(
  payload: unknown,
): { ok: true; imageBase64: string; mediaType: MediaType } | { ok: false; reason: 'invalid' | 'too_large' } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid' };
  }

  const record = payload as { imageBase64?: unknown; mediaType?: unknown };
  if (typeof record.imageBase64 !== 'string' || typeof record.mediaType !== 'string') {
    return { ok: false, reason: 'invalid' };
  }
  if (!MEDIA_TYPES.has(record.mediaType)) {
    return { ok: false, reason: 'invalid' };
  }
  if (record.imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    return { ok: false, reason: 'too_large' };
  }

  const imageBase64 = record.imageBase64.replace(/\s/g, '');
  if (!imageBase64 || imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    return { ok: false, reason: imageBase64.length > MAX_IMAGE_BASE64_CHARS ? 'too_large' : 'invalid' };
  }

  return { ok: true, imageBase64, mediaType: record.mediaType as MediaType };
}

function readQuota(value: unknown): QuotaDecision | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.allowed !== 'boolean') return null;
  return {
    allowed: row.allowed,
    reason: typeof row.reason === 'string' ? row.reason : null,
    retry_after_seconds: nonNegativeInt(row.retry_after_seconds),
    hourly_remaining: nonNegativeInt(row.hourly_remaining),
    daily_remaining: nonNegativeInt(row.daily_remaining),
  };
}

async function writeAudit(
  admin: SupabaseClient,
  row: {
    user_id: string;
    status: AuditStatus;
    model?: string | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
    latency_ms?: number | null;
    error_code?: string | null;
  },
) {
  const { error } = await admin.from('receipt_scan_audit_logs').insert({
    user_id: row.user_id,
    status: row.status,
    model: row.model ?? null,
    input_tokens: row.input_tokens ?? null,
    output_tokens: row.output_tokens ?? null,
    latency_ms: row.latency_ms ?? null,
    error_code: row.error_code ?? null,
  });
  if (error) {
    console.error('[scan-receipt] audit log failed', error.message);
  }
}

function parseModelReceipt(body: unknown): ScannedReceipt | null {
  const text = modelText(body);
  if (!text) return null;

  const stripped = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1)) as {
      merchant_name?: unknown;
      restaurantName?: unknown;
      restaurant_name?: unknown;
      website?: unknown;
      items?: unknown;
      subtotal?: unknown;
      tax?: unknown;
      total?: unknown;
    };

    const items = Array.isArray(parsed.items)
      ? parsed.items.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const record = item as { name?: unknown; price?: unknown };
          const name = typeof record.name === 'string' ? record.name.trim() : '';
          if (!name) return [];
          return [{ name, price: asMoney(record.price) }];
        })
      : [];

    return {
      merchant_name: readMerchantName(parsed),
      website: typeof parsed.website === 'string' && parsed.website.trim() ? parsed.website.trim() : null,
      items,
      subtotal: asMoney(parsed.subtotal),
      tax: asMoney(parsed.tax),
      total: asMoney(parsed.total),
    };
  } catch {
    return null;
  }
}

function modelText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .flatMap((block) => {
      if (!block || typeof block !== 'object') return [];
      const record = block as { type?: unknown; text?: unknown };
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    })
    .join('\n')
    .trim();
  return text || null;
}

function readModel(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const model = (body as { model?: unknown }).model;
  return typeof model === 'string' && model.trim() ? model.trim() : null;
}

function readTokens(body: unknown, field: 'input_tokens' | 'output_tokens'): number | null {
  if (!body || typeof body !== 'object') return null;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;
  const value = (usage as Record<string, unknown>)[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
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

function nonNegativeInt(value: unknown) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.trunc(number));
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}
