import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.119.0';

import { chunk, EXPO_PUSH_RECEIPTS_URL, EXPO_RECEIPT_CHUNK, postExpo, safeErrorMessage, type ExpoReceipt } from '../_shared/expoPush.ts';
import { secretsMatch } from '../_shared/timingSafeEqual.ts';

const TOKEN_PATTERN = /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type SentRow = {
  id: string;
  expo_ticket_id: string;
  push_token: string | null;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const authorized = secretsMatch(req.headers.get('x-cron-secret'), Deno.env.get('CRON_SECRET'))
    || secretsMatch(bearer(req.headers.get('Authorization')), serviceRoleKey);
  if (!authorized) return json(401, { error: 'Unauthorized' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const accessToken = Deno.env.get('EXPO_ACCESS_TOKEN');
  if (!supabaseUrl || !serviceRoleKey || !accessToken) {
    logCode('CONFIG_ERROR');
    return json(500, { error: 'Unavailable' });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = Date.now();
  const checkedAt = new Date(now).toISOString();
  const expiredBefore = new Date(now - DAY_MS).toISOString();
  const readyBefore = new Date(now - FIFTEEN_MINUTES_MS).toISOString();

  const expired = await admin
    .from('push_notification_logs')
    .update({ status: 'expired', receipt_checked_at: checkedAt, error_code: 'receipt_window_closed' })
    .eq('status', 'sent')
    .not('expo_ticket_id', 'is', null)
    .lt('created_at', expiredBefore);
  if (expired.error) {
    logCode('EXPIRE_FAILED');
    return json(500, { error: 'Unavailable' });
  }

  const pending = await admin
    .from('push_notification_logs')
    .select('id, expo_ticket_id, push_token')
    .eq('status', 'sent')
    .not('expo_ticket_id', 'is', null)
    .lte('created_at', readyBefore)
    .gt('created_at', expiredBefore)
    .order('created_at', { ascending: true })
    .limit(EXPO_RECEIPT_CHUNK);
  if (pending.error) {
    logCode('RECEIPT_LOOKUP_FAILED');
    return json(500, { error: 'Unavailable' });
  }

  const rows = ((pending.data ?? []) as SentRow[]).filter((row) => row.expo_ticket_id);
  let reconciled = 0;

  for (const batch of chunk(rows, EXPO_RECEIPT_CHUNK)) {
    let receipts: Record<string, ExpoReceipt>;
    try {
      const result = await postExpo<{ data?: Record<string, ExpoReceipt> }>(
        EXPO_PUSH_RECEIPTS_URL,
        accessToken,
        { ids: batch.map((row) => row.expo_ticket_id) },
      );
      receipts = result.data ?? {};
    } catch {
      logCode('RECEIPT_FETCH_FAILED');
      return json(503, { error: 'Unavailable' });
    }

    for (const row of batch) {
      const receipt = receipts[row.expo_ticket_id];
      if (!receipt) continue;
      reconciled += 1;
      if (receipt.status === 'ok') {
        await updateLog(admin, row.id, { status: 'receipt_ok', receipt_checked_at: checkedAt, error_code: null, error_message: null });
        continue;
      }
      const errorCode = receipt.details?.error ?? 'receipt_error';
      if (errorCode === 'DeviceNotRegistered') {
        await updateLog(admin, row.id, {
          status: 'device_not_registered',
          receipt_checked_at: checkedAt,
          error_code: errorCode,
          error_message: safeErrorMessage(receipt.message),
        });
        if (row.push_token && TOKEN_PATTERN.test(row.push_token)) {
          const removed = await admin.from('push_tokens').delete().eq('token', row.push_token);
          if (removed.error) logCode('DEAD_TOKEN_DELETE_FAILED');
          else logCode('DEAD_TOKEN_REMOVED');
          await admin.from('user_push_tokens').delete().eq('expo_push_token', row.push_token);
        }
        continue;
      }
      await updateLog(admin, row.id, {
        status: 'failed',
        receipt_checked_at: checkedAt,
        error_code: errorCode.slice(0, 80),
        error_message: safeErrorMessage(receipt.message),
      });
    }
  }

  return json(200, { ok: true, reconciled });
});

function bearer(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function logCode(code: string) {
  console.log(JSON.stringify({ code }));
}

async function updateLog(
  admin: ReturnType<typeof createClient>,
  id: string,
  patch: Record<string, unknown>,
) {
  const { error } = await admin.from('push_notification_logs').update(patch).eq('id', id);
  if (error) logCode('LEDGER_UPDATE_FAILED');
}
