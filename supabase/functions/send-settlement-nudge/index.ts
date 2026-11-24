import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.119.0';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
const HOURLY_CAP = 10;
const CHUNK_SIZE = 100;
const PUSH_TIMEOUT_MS = 15_000;
const NUDGE_TITLE = 'Settlement reminder';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type DeliveryStatus = 'sent' | 'no_tokens' | 'opted_out' | 'failed';

type LedgerRow = {
  sender_id: string;
  delivery_status: DeliveryStatus;
  delivered_count: number;
  created_at?: string;
};

type ExpoTicket = {
  status?: string;
  details?: { error?: string };
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json(405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    logCode('CONFIG_ERROR');
    return json(500, { error: 'Reminders are temporarily unavailable.', code: 'CONFIG_ERROR' });
  }

  const token = bearerToken(req.headers.get('Authorization'));
  if (!token) {
    return json(401, { error: 'Authentication required', code: 'UNAUTHORIZED' });
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: authError } = await userClient.auth.getUser(token);
  const user = userData?.user;
  if (authError || !user) {
    return json(401, { error: 'Authentication required', code: 'UNAUTHORIZED' });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'Invalid reminder request', code: 'INVALID_PAYLOAD' });
  }

  const input = readInput(payload);
  if (!input) {
    return json(400, { error: 'Invalid reminder request', code: 'INVALID_PAYLOAD' });
  }
  if (input.recipientId === user.id) {
    return json(400, { error: 'You cannot remind yourself.', code: 'INVALID_RECIPIENT' });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const existing = await findByIdempotencyKey(admin, input.idempotencyKey);
  if (!existing.ok) {
    logCode('IDEMPOTENCY_LOOKUP_FAILED');
    return json(500, { error: 'Could not send that reminder.', code: 'LOOKUP_FAILED' });
  }
  if (existing.row) {
    if (existing.row.sender_id !== user.id) {
      return json(409, { error: 'That reminder could not be matched.', code: 'IDEMPOTENCY_CONFLICT' });
    }
    return json(200, resultForLedger(existing.row));
  }

  const money = await verifyUnsettledAmount(admin, {
    receiptId: input.receiptId,
    recipientId: input.recipientId,
    senderId: user.id,
  });
  if (!money.ok) {
    return json(money.status, { error: money.error, code: money.code });
  }

  const cooldown = await findCooldown(admin, user.id, input.recipientId, input.receiptId);
  if (!cooldown.ok) {
    logCode('COOLDOWN_LOOKUP_FAILED');
    return json(500, { error: 'Could not send that reminder.', code: 'LOOKUP_FAILED' });
  }
  if (cooldown.nextAllowedAt) {
    return json(429, { code: 'NUDGE_COOLDOWN', nextAllowedAt: cooldown.nextAllowedAt });
  }

  const rate = await senderWithinHourlyCap(admin, user.id);
  if (!rate.ok) {
    logCode('RATE_LOOKUP_FAILED');
    return json(500, { error: 'Could not send that reminder.', code: 'LOOKUP_FAILED' });
  }
  if (!rate.allowed) {
    return json(429, { code: 'RATE_LIMITED' });
  }

  const preferences = await recipientPreferences(admin, input.recipientId);
  if (!preferences.ok) {
    logCode('PREFERENCE_LOOKUP_FAILED');
    return json(500, { error: 'Could not send that reminder.', code: 'LOOKUP_FAILED' });
  }
  if (!preferences.nudgesEnabled) {
    const recorded = await recordNudge(admin, {
      senderId: user.id,
      recipientId: input.recipientId,
      receiptId: input.receiptId,
      amountPence: money.amountPence,
      idempotencyKey: input.idempotencyKey,
      deliveryStatus: 'opted_out',
      deliveredCount: 0,
    });
    if (!recorded.ok) {
      logCode('LEDGER_WRITE_FAILED');
      return json(500, { error: 'Could not send that reminder.', code: 'LEDGER_WRITE_FAILED' });
    }
    return json(200, resultForLedger(recorded.row));
  }

  const tokens = await recipientTokens(admin, input.recipientId);
  if (!tokens.ok) {
    logCode('TOKEN_LOOKUP_FAILED');
    return json(500, { error: 'Could not send that reminder.', code: 'LOOKUP_FAILED' });
  }
  if (tokens.values.length === 0) {
    const recorded = await recordNudge(admin, {
      senderId: user.id,
      recipientId: input.recipientId,
      receiptId: input.receiptId,
      amountPence: money.amountPence,
      idempotencyKey: input.idempotencyKey,
      deliveryStatus: 'no_tokens',
      deliveredCount: 0,
    });
    if (!recorded.ok) {
      logCode('LEDGER_WRITE_FAILED');
      return json(500, { error: 'Could not send that reminder.', code: 'LEDGER_WRITE_FAILED' });
    }
    return json(200, resultForLedger(recorded.row));
  }

  const expoAccessToken = Deno.env.get('EXPO_ACCESS_TOKEN');
  if (!expoAccessToken) {
    logCode('PUSH_NOT_CONFIGURED');
    return json(503, { error: 'Reminders are temporarily unavailable.', code: 'PUSH_NOT_CONFIGURED' });
  }

  const profileName = await senderDisplayName(admin, user.id);
  const body = formatSettlementNudgeBody({
    senderFirstName: profileName,
    amountPence: money.amountPence,
    merchantName: money.merchantName,
    hideAmounts: preferences.hideAmounts,
  });

  const dispatch = await dispatchExpoPush({
    accessToken: expoAccessToken,
    tokens: tokens.values,
    receiptId: input.receiptId,
    body,
  });

  if (dispatch.staleTokens.length > 0) {
    const { error: deleteError } = await admin
      .from('user_push_tokens')
      .delete()
      .eq('user_id', input.recipientId)
      .in('expo_push_token', dispatch.staleTokens);
    if (deleteError) logCode('STALE_TOKEN_DELETE_FAILED');
    else logCode('STALE_TOKEN_REMOVED');
  }

  const deliveredCount = dispatch.deliveredCount;
  const deliveryStatus: DeliveryStatus = deliveredCount > 0 ? 'sent' : 'failed';
  const recorded = await recordNudge(admin, {
    senderId: user.id,
    recipientId: input.recipientId,
    receiptId: input.receiptId,
    amountPence: money.amountPence,
    idempotencyKey: input.idempotencyKey,
    deliveryStatus,
    deliveredCount,
  });
  if (!recorded.ok) {
    logCode('LEDGER_WRITE_FAILED');
    return json(500, { error: 'Could not send that reminder.', code: 'LEDGER_WRITE_FAILED' });
  }

  if (!dispatch.ok && recorded.row.delivered_count === 0) {
    logCode('PUSH_UPSTREAM_ERROR');
    return json(502, { error: 'Could not send that reminder.', code: 'PUSH_UPSTREAM_ERROR', sent: false, deliveredCount: 0 });
  }

  return json(200, resultForLedger(recorded.row));
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function bearerToken(header: string | null) {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)/i);
  return match?.[1]?.trim() || null;
}

function logCode(code: string) {
  console.error(`[send-settlement-nudge] ${code}`);
}

function readInput(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as { receiptId?: unknown; recipientId?: unknown; idempotencyKey?: unknown };
  if (typeof record.receiptId !== 'string' || !UUID_PATTERN.test(record.receiptId)) return null;
  if (typeof record.recipientId !== 'string' || !UUID_PATTERN.test(record.recipientId)) return null;
  if (typeof record.idempotencyKey !== 'string') return null;
  const idempotencyKey = record.idempotencyKey.trim();
  if (idempotencyKey.length < 1 || idempotencyKey.length > 128) return null;
  if (/[\u0000-\u001F\u007F]/.test(idempotencyKey)) return null;
  return { receiptId: record.receiptId, recipientId: record.recipientId, idempotencyKey };
}

function resultForLedger(row: LedgerRow) {
  if (row.delivery_status === 'opted_out') return { sent: false, reason: 'RECIPIENT_OPTED_OUT' };
  if (row.delivery_status === 'no_tokens') return { sent: false, reason: 'NO_REGISTERED_DEVICE' };
  return { sent: row.delivered_count > 0, deliveredCount: row.delivered_count };
}

async function findByIdempotencyKey(admin: SupabaseClient, idempotencyKey: string) {
  const { data, error } = await admin
    .from('settlement_nudges')
    .select('sender_id, delivery_status, delivered_count, created_at')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error) return { ok: false as const, row: null };
  return { ok: true as const, row: data ? normalizeLedger(data) : null };
}

async function verifyUnsettledAmount(
  admin: SupabaseClient,
  input: { receiptId: string; recipientId: string; senderId: string },
) {
  const { data, error } = await admin
    .from('receipts')
    .select('id, host_id, paid_by, merchant_name, settled_at, status')
    .eq('id', input.receiptId)
    .maybeSingle();
  if (error) return failMoney(500, 'LOOKUP_FAILED', 'Could not send that reminder.');
  if (!data) return failMoney(404, 'RECEIPT_NOT_FOUND', 'That receipt could not be found.');

  const receipt = data as {
    host_id?: unknown;
    paid_by?: unknown;
    merchant_name?: unknown;
    settled_at?: unknown;
    status?: unknown;
  };
  const hostId = typeof receipt.host_id === 'string' ? receipt.host_id : '';
  const paidBy = typeof receipt.paid_by === 'string' ? receipt.paid_by : null;
  if (input.senderId !== hostId && input.senderId !== paidBy) {
    return failMoney(403, 'NOT_AUTHORIZED', 'You cannot send a reminder for this receipt.');
  }
  if (receipt.settled_at || receipt.status === 'settled') {
    return failMoney(409, 'ALREADY_SETTLED', 'This receipt is already marked settled.');
  }

  const creditorId = paidBy ?? hostId;
  if (input.recipientId === creditorId) {
    return failMoney(422, 'NOTHING_OWED', 'There is nothing unsettled to remind them about.');
  }

  const splits = await admin
    .from('receipt_splits')
    .select('amount_minor')
    .eq('receipt_id', input.receiptId)
    .eq('user_id', input.recipientId);
  if (splits.error) return failMoney(500, 'LOOKUP_FAILED', 'Could not send that reminder.');

  const amountPence = sumPence(splits.data ?? []);
  if (amountPence <= 0) {
    return failMoney(422, 'NOTHING_OWED', 'There is nothing unsettled to remind them about.');
  }

  return {
    ok: true as const,
    amountPence,
    merchantName: typeof receipt.merchant_name === 'string' ? receipt.merchant_name : '',
  };
}

function failMoney(status: number, code: string, error: string) {
  return { ok: false as const, status, code, error };
}

function sumPence(rows: unknown[]) {
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = (row as { amount_minor?: unknown }).amount_minor;
    const pence = readPositiveInt(value);
    if (pence != null) total += pence;
  }
  return total;
}

function readPositiveInt(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

async function findCooldown(admin: SupabaseClient, senderId: string, recipientId: string, receiptId: string) {
  const boundary = new Date(Date.now() - COOLDOWN_MS).toISOString();
  const { data, error } = await admin
    .from('settlement_nudges')
    .select('created_at')
    .eq('sender_id', senderId)
    .eq('recipient_id', recipientId)
    .eq('receipt_id', receiptId)
    .eq('delivery_status', 'sent')
    .gt('created_at', boundary)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return { ok: false as const, nextAllowedAt: null };
  const createdAt = data?.[0]?.created_at;
  if (typeof createdAt !== 'string') return { ok: true as const, nextAllowedAt: null };
  const sentAt = Date.parse(createdAt);
  if (!Number.isFinite(sentAt)) return { ok: true as const, nextAllowedAt: null };
  return { ok: true as const, nextAllowedAt: new Date(sentAt + COOLDOWN_MS).toISOString() };
}

async function senderWithinHourlyCap(admin: SupabaseClient, senderId: string) {
  const boundary = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count, error } = await admin
    .from('settlement_nudges')
    .select('id', { count: 'exact', head: true })
    .eq('sender_id', senderId)
    .gt('created_at', boundary);
  if (error || count == null) return { ok: false as const, allowed: false };
  return { ok: true as const, allowed: count < HOURLY_CAP };
}

async function recipientPreferences(admin: SupabaseClient, recipientId: string) {
  const { data, error } = await admin
    .from('user_notification_preferences')
    .select('settlement_nudges_enabled, hide_amounts_in_notifications')
    .eq('user_id', recipientId)
    .maybeSingle();
  if (error) return { ok: false as const, nudgesEnabled: false, hideAmounts: true };
  if (!data) return { ok: true as const, nudgesEnabled: true, hideAmounts: false };
  const row = data as { settlement_nudges_enabled?: unknown; hide_amounts_in_notifications?: unknown };
  return {
    ok: true as const,
    nudgesEnabled: row.settlement_nudges_enabled !== false,
    hideAmounts: row.hide_amounts_in_notifications === true,
  };
}

async function recipientTokens(admin: SupabaseClient, recipientId: string) {
  const { data, error } = await admin
    .from('user_push_tokens')
    .select('expo_push_token')
    .eq('user_id', recipientId);
  if (error) return { ok: false as const, values: [] as string[] };
  const values = (data ?? []).flatMap((row) => {
    const token = (row as { expo_push_token?: unknown }).expo_push_token;
    return typeof token === 'string' && TOKEN_PATTERN.test(token) ? [token] : [];
  });
  return { ok: true as const, values: [...new Set(values)] };
}

async function senderDisplayName(admin: SupabaseClient, senderId: string) {
  const { data, error } = await admin.from('profiles').select('full_name').eq('id', senderId).maybeSingle();
  if (error || !data) return 'Someone';
  const fullName = (data as { full_name?: unknown }).full_name;
  return typeof fullName === 'string' ? fullName : 'Someone';
}

async function dispatchExpoPush(input: { accessToken: string; tokens: string[]; receiptId: string; body: string }) {
  const messages = input.tokens.map((to) => ({
    to,
    title: NUDGE_TITLE,
    body: input.body,
    data: { type: 'settlement_nudge', receiptId: input.receiptId },
    sound: 'default',
    priority: 'high',
    channelId: 'settlement-nudges',
    ttl: 86400,
  }));

  let deliveredCount = 0;
  const staleTokens: string[] = [];
  let ok = true;

  for (let index = 0; index < messages.length; index += CHUNK_SIZE) {
    const chunk = messages.slice(index, index + CHUNK_SIZE);
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (!response.ok) {
        ok = false;
        continue;
      }
      const payload = await response.json().catch(() => null);
      const tickets = readTickets(payload);
      chunk.forEach((message, ticketIndex) => {
        const ticket = tickets[ticketIndex];
        if (ticket?.status === 'ok') {
          deliveredCount += 1;
          return;
        }
        if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          staleTokens.push(message.to);
        }
      });
    } catch {
      ok = false;
    }
  }

  return { ok, deliveredCount, staleTokens };
}

function readTickets(payload: unknown): ExpoTicket[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((ticket) => {
    if (!ticket || typeof ticket !== 'object') return [];
    const record = ticket as { status?: unknown; details?: unknown };
    const details = record.details && typeof record.details === 'object'
      ? record.details as { error?: unknown }
      : undefined;
    return [{
      status: typeof record.status === 'string' ? record.status : undefined,
      details: details && typeof details.error === 'string' ? { error: details.error } : undefined,
    }];
  });
}

async function recordNudge(
  admin: SupabaseClient,
  row: {
    senderId: string;
    recipientId: string;
    receiptId: string;
    amountPence: number;
    idempotencyKey: string;
    deliveryStatus: DeliveryStatus;
    deliveredCount: number;
  },
) {
  const { error } = await admin.from('settlement_nudges').insert({
    sender_id: row.senderId,
    recipient_id: row.recipientId,
    receipt_id: row.receiptId,
    amount_pence: row.amountPence,
    idempotency_key: row.idempotencyKey,
    delivery_status: row.deliveryStatus,
    delivered_count: row.deliveredCount,
  });
  const stored: LedgerRow = {
    sender_id: row.senderId,
    delivery_status: row.deliveryStatus,
    delivered_count: row.deliveredCount,
  };
  if (!error) return { ok: true as const, row: stored };
  if (error.code === '23505') {
    const existing = await findByIdempotencyKey(admin, row.idempotencyKey);
    if (existing.ok && existing.row && existing.row.sender_id === row.senderId) {
      return { ok: true as const, row: existing.row };
    }
  }
  return { ok: false as const };
}

function normalizeLedger(row: {
  sender_id: string;
  delivery_status: string;
  delivered_count: number;
  created_at?: string;
}): LedgerRow | null {
  if (
    row.delivery_status !== 'sent'
    && row.delivery_status !== 'no_tokens'
    && row.delivery_status !== 'opted_out'
    && row.delivery_status !== 'failed'
  ) {
    return null;
  }
  return {
    sender_id: row.sender_id,
    delivery_status: row.delivery_status,
    delivered_count: Number.isFinite(row.delivered_count) ? row.delivered_count : 0,
    created_at: row.created_at,
  };
}

function senderFirstName(value: unknown) {
  if (typeof value !== 'string') return 'Someone';
  const token = value.trim().split(/\s+/)[0] ?? '';
  const cleaned = token.replace(/[^\p{L}'’-]/gu, '').slice(0, 24);
  return cleaned || 'Someone';
}

function lockScreenMerchantName(value: unknown) {
  if (typeof value !== 'string') return 'your receipt';
  const cleaned = value
    .replace(/\b\d{2}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{6,8}\b/g, '')
    .replace(/[^\p{L}\p{N}&'., -]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned || 'your receipt';
}

function formatPoundsFromPence(amountPence: number) {
  const abs = Math.abs(Math.trunc(amountPence));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function formatSettlementNudgeBody(input: {
  senderFirstName: string;
  amountPence: number;
  merchantName: string;
  hideAmounts: boolean;
}) {
  const name = senderFirstName(input.senderFirstName);
  if (input.hideAmounts) return `${name} sent you a friendly settlement reminder`;
  return `${name} sent a friendly reminder for £${formatPoundsFromPence(input.amountPence)} (${lockScreenMerchantName(input.merchantName)})`;
}
