import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.119.0';

import {
  buildHostPaidEmail,
  constantTimeEqual,
  isUnpaidToPaidTransition,
  type WebhookPayload,
} from '../_shared/hostPaidEmail.ts';
import {
  claimHostPaidEmail,
  newClaimTimestamp,
  rollbackHostPaidClaim,
  type HostPaidClaimClient,
} from '../_shared/hostPaidClaim.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type ShareRow = {
  amount_owed_pence?: unknown;
  is_paid?: unknown;
  is_host?: unknown;
  host_confirmed_at?: unknown;
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed' });

  const webhookSecret = readEnv('VELOR_WEBHOOK_SECRET');
  const resendKey = readEnv('RESEND_API_KEY');
  const supabaseUrl = readEnv('SUPABASE_URL');
  const serviceRoleKey = readEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!webhookSecret || !resendKey || !supabaseUrl || !serviceRoleKey) {
    const missing = !webhookSecret
      ? 'VELOR_WEBHOOK_SECRET'
      : !resendKey
        ? 'RESEND_API_KEY'
        : !supabaseUrl
          ? 'SUPABASE_URL'
          : 'SUPABASE_SERVICE_ROLE_KEY';
    console.log(JSON.stringify({ status: 'missing_env', name: missing }));
    return json(500, { ok: false, error: 'missing_env' });
  }

  const provided = req.headers.get('x-velor-webhook-secret') ?? '';
  if (!constantTimeEqual(provided, webhookSecret)) return json(401, { ok: false, error: 'unauthorized' });

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  if (!isWebhookPayload(payload) || !isUnpaidToPaidTransition(payload)) {
    return json(200, { ok: true, skipped: 'not_a_paid_transition' });
  }

  const share = readShare(payload);
  if (!share || share.isHost) return json(200, { ok: true, skipped: 'not_a_paid_transition' });

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Unique per request. Rollbacks match on it so they only undo this claim.
  const claimedAt = newClaimTimestamp();
  const claim = await claimHostPaidEmail(admin as unknown as HostPaidClaimClient, share.shareId, claimedAt);
  if (claim === 'error') {
    console.log(JSON.stringify({ status: 'claim_failed', share_id: share.shareId }));
    return json(500, { ok: false });
  }
  if (claim === 'already_notified') return json(200, { ok: true, skipped: 'already_notified' });

  const receiptResult = await admin
    .from('receipts')
    .select('id, host_id, merchant_name, restaurant_name, group_id, total_amount')
    .eq('id', share.receiptId)
    .maybeSingle();

  if (receiptResult.error) {
    await rollbackClaim(admin, share.shareId, claimedAt);
    console.log(JSON.stringify({ status: 'receipt_lookup_failed', share_id: share.shareId }));
    return json(500, { ok: false });
  }

  const receipt = asRecord(receiptResult.data);
  const hostUserId = typeof receipt?.host_id === 'string' && UUID_PATTERN.test(receipt.host_id) ? receipt.host_id : null;
  if (!receipt || !hostUserId) {
    await rollbackClaim(admin, share.shareId, claimedAt);
    return json(200, { ok: true, skipped: 'not_a_paid_transition' });
  }

  const sharesResult = await admin
    .from('receipt_share_participants')
    .select('amount_owed_pence, is_paid, is_host, host_confirmed_at')
    .eq('receipt_id', share.receiptId);

  if (sharesResult.error || !Array.isArray(sharesResult.data)) {
    await rollbackClaim(admin, share.shareId, claimedAt);
    console.log(JSON.stringify({ status: 'shares_lookup_failed', share_id: share.shareId }));
    return json(500, { ok: false });
  }

  let groupName: string | null = null;
  const groupId = typeof receipt.group_id === 'string' && UUID_PATTERN.test(receipt.group_id) ? receipt.group_id : null;
  if (groupId) {
    const groupResult = await admin.from('groups').select('name').eq('id', groupId).maybeSingle();
    if (!groupResult.error) {
      const group = asRecord(groupResult.data);
      groupName = typeof group?.name === 'string' ? group.name : null;
    }
  }

  const userResult = await admin.auth.admin.getUserById(hostUserId);
  const hostEmail = userResult.data?.user?.email;
  if (userResult.error) {
    await rollbackClaim(admin, share.shareId, claimedAt);
    console.log(JSON.stringify({ status: 'host_lookup_failed', share_id: share.shareId }));
    return json(500, { ok: false });
  }
  if (typeof hostEmail !== 'string' || hostEmail.length === 0) {
    console.log(JSON.stringify({ status: 'skipped_no_host_email', share_id: share.shareId }));
    return json(200, { ok: true, skipped: 'no_host_email' });
  }

  const receiptTitle = firstText(receipt.merchant_name) ?? firstText(receipt.restaurant_name) ?? 'Receipt';
  const email = buildHostPaidEmail({
    guestName: share.guestName,
    receiptTitle,
    groupName,
    paidAmountPence: share.amountPence,
    remainingBalancePence: remainingBalancePence(totalPence(receipt.total_amount), sharesResult.data as ShareRow[]),
  });
  const from = readEnv('RESEND_FROM_EMAIL') ?? 'Velor <onboarding@resend.dev>';

  let httpStatus = 0;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `velor-paid-${share.shareId}`,
      },
      body: JSON.stringify({
        from,
        to: [hostEmail],
        subject: email.subject,
        html: email.html,
        text: email.text,
      }),
    });
    httpStatus = response.status;
    if (response.status < 200 || response.status >= 300) {
      await rollbackClaim(admin, share.shareId, claimedAt);
      console.log(JSON.stringify({ status: 'resend_error', http_status: httpStatus, share_id: share.shareId }));
      return json(502, { ok: false });
    }
  } catch {
    await rollbackClaim(admin, share.shareId, claimedAt);
    console.log(JSON.stringify({ status: 'resend_error', http_status: httpStatus, share_id: share.shareId }));
    return json(502, { ok: false });
  }

  console.log(JSON.stringify({ status: 'sent', share_id: share.shareId, receipt_id: share.receiptId }));
  return json(200, { ok: true });
});

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function readEnv(name: string): string | null {
  const value = Deno.env.get(name);
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function isWebhookPayload(value: unknown): value is WebhookPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readShare(payload: WebhookPayload): {
  shareId: string;
  receiptId: string;
  guestName: string;
  amountPence: number;
  isHost: boolean;
} | null {
  const record = asRecord(payload.record);
  if (!record) return null;
  const shareId = typeof record.id === 'string' && UUID_PATTERN.test(record.id) ? record.id.toLowerCase() : null;
  const receiptId = typeof record.receipt_id === 'string' && UUID_PATTERN.test(record.receipt_id) ? record.receipt_id.toLowerCase() : null;
  if (!shareId || !receiptId) return null;
  return {
    shareId,
    receiptId,
    guestName: firstText(record.display_name) ?? 'Guest',
    amountPence: readPence(record.amount_owed_pence),
    isHost: record.is_host === true,
  };
}

function remainingBalancePence(total: number, shares: ShareRow[]): number {
  let host = 0;
  let paid = 0;
  for (const share of shares) {
    const amount = readPence(share.amount_owed_pence);
    const confirmed = typeof share.host_confirmed_at === 'string' && share.host_confirmed_at.length > 0;
    if (share.is_host === true && confirmed) host += amount;
    else if (share.is_host !== true && share.is_paid === true) paid += amount;
  }
  return Math.max(0, total - host - paid);
}

function totalPence(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.round(numeric * 100));
}

function readPence(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? Math.max(0, parsed) : 0;
  }
  return 0;
}

function firstText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > 0 ? clean.slice(0, 120) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function rollbackClaim(
  admin: ReturnType<typeof createClient>,
  shareId: string,
  claimedAt: string,
) {
  const ok = await rollbackHostPaidClaim(admin as unknown as HostPaidClaimClient, shareId, claimedAt);
  if (!ok) console.log(JSON.stringify({ status: 'rollback_failed', share_id: shareId }));
}
