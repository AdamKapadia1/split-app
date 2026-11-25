import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.119.0';

import {
  decideHostPaidNotification,
  formatSharePaidNotification,
  isSharePaidTransition,
  lockScreenMerchantName,
  type SharePaidSnapshot,
} from '../../../src/utils/hostPaidNotification.ts';
import { chunk, EXPO_PUSH_CHUNK, EXPO_PUSH_SEND_URL, postExpo, safeErrorMessage, tokenKeyPrefix, type ExpoTicket } from '../_shared/expoPush.ts';
import { secretsMatch } from '../_shared/timingSafeEqual.ts';

const TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;

type ReceiptRow = {
  id: string;
  host_id: string | null;
  merchant_name: string | null;
  restaurant_name: string | null;
};

type TokenRow = {
  token: string;
};

type LogRow = {
  id: string;
  push_token: string | null;
  idempotency_key: string;
  status: string;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const webhookSecret = Deno.env.get('WEBHOOK_SECRET');
  if (!secretsMatch(req.headers.get('x-webhook-secret'), webhookSecret)) {
    return json(401, { error: 'Unauthorized' });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    logCode('CONFIG_ERROR');
    return json(500, { error: 'Unavailable' });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: 'Invalid payload' });
  }

  const body = asRecord(payload);
  const record = asRecord(body?.record) as SharePaidSnapshot | null;
  const oldRecord = asRecord(body?.old_record) as SharePaidSnapshot | null;
  const transition = {
    type: body?.type,
    table: body?.table,
    record,
    oldRecord,
  };
  if (!isSharePaidTransition(transition)) return json(200, { ok: true, ignored: true });

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const receiptId = typeof record?.receipt_id === 'string' ? record.receipt_id : '';
  const receipt = await admin
    .from('receipts')
    .select('id, host_id, merchant_name, restaurant_name')
    .eq('id', receiptId)
    .maybeSingle();
  if (receipt.error) {
    logCode('BILL_LOOKUP_FAILED');
    return json(500, { error: 'Unavailable' });
  }
  const bill = receipt.data as ReceiptRow | null;
  const hostId = bill?.host_id ?? null;
  if (!bill || !hostId) return json(200, { ok: true, ignored: true });

  const decision = decideHostPaidNotification(transition, hostId);
  if (decision.action === 'ignore') return json(200, { ok: true, ignored: true });
  const venue = lockScreenMerchantName(bill.merchant_name || bill.restaurant_name);

  const message = formatSharePaidNotification({
    guestName: decision.guestName,
    amountPence: decision.amountPence,
    venue,
    receiptId: decision.receiptId,
    shareId: decision.shareId,
  });
  if (!message) return json(200, { ok: true, ignored: true });

  const tokens = await admin
    .from('push_tokens')
    .select('token')
    .eq('user_id', hostId);
  if (tokens.error) {
    logCode('TOKEN_LOOKUP_FAILED');
    return json(500, { error: 'Unavailable' });
  }

  const deviceTokens = ((tokens.data ?? []) as TokenRow[])
    .map((row) => row.token)
    .filter((token) => TOKEN_PATTERN.test(token));

  if (deviceTokens.length === 0) {
    const { error } = await admin.from('push_notification_logs').upsert({
      idempotency_key: `share_paid:${decision.shareId}`,
      event_type: 'share_paid',
      bill_id: decision.receiptId,
      share_id: decision.shareId,
      recipient_user_id: hostId,
      push_token: null,
      status: 'failed',
      error_code: 'no_tokens',
      error_message: 'No registered device',
    }, { onConflict: 'idempotency_key', ignoreDuplicates: true });
    if (error) {
      logCode('LEDGER_WRITE_FAILED');
      return json(500, { error: 'Unavailable' });
    }
    return json(200, { ok: true, delivered: 0 });
  }

  const accessToken = Deno.env.get('EXPO_ACCESS_TOKEN');
  if (!accessToken) {
    logCode('PUSH_NOT_CONFIGURED');
    return json(503, { error: 'Unavailable' });
  }

  const pending: { idempotency_key: string; push_token: string }[] = [];
  for (const token of deviceTokens) {
    pending.push({
      idempotency_key: `share_paid:${decision.shareId}:${await tokenKeyPrefix(token)}`,
      push_token: token,
    });
  }

  const { data: inserted, error: insertError } = await admin
    .from('push_notification_logs')
    .upsert(pending.map((row) => ({
      idempotency_key: row.idempotency_key,
      event_type: 'share_paid',
      bill_id: decision.receiptId,
      share_id: decision.shareId,
      recipient_user_id: hostId,
      push_token: row.push_token,
      status: 'pending',
    })), { onConflict: 'idempotency_key', ignoreDuplicates: true })
    .select('id, idempotency_key, push_token, status');

  if (insertError) {
    logCode('LEDGER_WRITE_FAILED');
    return json(500, { error: 'Unavailable' });
  }

  const claimed = ((inserted ?? []) as LogRow[]).filter((row) => row.status === 'pending' && row.push_token && TOKEN_PATTERN.test(row.push_token));
  if (claimed.length === 0) return json(200, { ok: true, duplicate: true });

  const tokenByKey = new Map(pending.map((row) => [row.idempotency_key, row.push_token]));
  let delivered = 0;

  for (const batch of chunk(claimed, EXPO_PUSH_CHUNK)) {
    const messages = batch.map((row) => ({
      to: tokenByKey.get(row.idempotency_key) ?? row.push_token,
      title: message.title,
      body: message.body,
      sound: 'default',
      priority: 'high',
      channelId: 'payments',
      data: message.data,
    }));

    let tickets: ExpoTicket[];
    try {
      const result = await postExpo<{ data?: ExpoTicket[] }>(EXPO_PUSH_SEND_URL, accessToken, messages);
      tickets = Array.isArray(result.data) ? result.data : [];
    } catch {
      logCode('PUSH_SEND_FAILED');
      await markRows(admin, batch.map((row) => row.id), {
        status: 'failed',
        error_code: 'push_send_failed',
        error_message: 'Expo push request failed',
      });
      return json(200, { ok: true, delivered });
    }

    for (let index = 0; index < batch.length; index += 1) {
      const row = batch[index];
      const ticket = tickets[index];
      const token = tokenByKey.get(row.idempotency_key) ?? row.push_token ?? '';
      if (ticket?.status === 'ok' && ticket.id) {
        delivered += 1;
        await markRows(admin, [row.id], { status: 'sent', expo_ticket_id: ticket.id, error_code: null, error_message: null });
        continue;
      }
      const errorCode = ticket?.details?.error ?? 'ticket_error';
      if (errorCode === 'DeviceNotRegistered') {
        await markRows(admin, [row.id], {
          status: 'device_not_registered',
          error_code: errorCode,
          error_message: safeErrorMessage(ticket?.message),
        });
        await deleteDeadToken(admin, token);
        continue;
      }
      await markRows(admin, [row.id], {
        status: 'failed',
        error_code: errorCode.slice(0, 80),
        error_message: safeErrorMessage(ticket?.message),
      });
    }
  }

  return json(200, { ok: true, delivered });
});

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function logCode(code: string) {
  console.log(JSON.stringify({ code }));
}

async function markRows(
  admin: ReturnType<typeof createClient>,
  ids: string[],
  patch: Record<string, unknown>,
) {
  const { error } = await admin.from('push_notification_logs').update(patch).in('id', ids);
  if (error) logCode('LEDGER_UPDATE_FAILED');
}

async function deleteDeadToken(admin: ReturnType<typeof createClient>, token: string) {
  if (!TOKEN_PATTERN.test(token)) return;
  const removed = await admin.from('push_tokens').delete().eq('token', token);
  if (removed.error) logCode('DEAD_TOKEN_DELETE_FAILED');
  else logCode('DEAD_TOKEN_REMOVED');
  const legacy = await admin.from('user_push_tokens').delete().eq('expo_push_token', token);
  if (legacy.error) logCode('LEGACY_TOKEN_DELETE_FAILED');
}
