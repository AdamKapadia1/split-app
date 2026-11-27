export const SHARE_PARTICIPANTS_TABLE = 'receipt_share_participants';

export type WebhookPayload = {
  type?: unknown;
  table?: unknown;
  schema?: unknown;
  record?: unknown;
  old_record?: unknown;
};

export type HostPaidEmailInput = {
  guestName: string;
  receiptTitle: string;
  groupName: string | null;
  paidAmountPence: number;
  remainingBalancePence: number;
};

export type HostPaidEmail = {
  subject: string;
  html: string;
  text: string;
};

export function constantTimeEqual(a: string, b: string): boolean {
  const left = typeof a === 'string' ? a : '';
  const right = typeof b === 'string' ? b : '';
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length, 1);
  let diff = leftBytes.length === rightBytes.length ? 0 : 1;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  if (left.length === 0 || right.length === 0) return false;
  return diff === 0;
}

export function isUnpaidToPaidTransition(payload: WebhookPayload): boolean {
  if (!isRecord(payload)) return false;
  if (payload.type !== 'UPDATE') return false;
  if (payload.table !== SHARE_PARTICIPANTS_TABLE) return false;
  const record = isRecord(payload.record) ? payload.record : null;
  const previous = isRecord(payload.old_record) ? payload.old_record : null;
  if (!record || !previous) return false;
  return previous.is_paid === false && record.is_paid === true;
}

export function escapeHtml(value: string): string {
  const source = typeof value === 'string' ? value : '';
  return source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatGbpFromPence(pence: number): string {
  const minor = Number.isFinite(pence) ? Math.max(0, Math.trunc(pence)) : 0;
  const pounds = Math.floor(minor / 100);
  const rest = minor % 100;
  return `£${pounds}.${String(rest).padStart(2, '0')}`;
}

export function buildHostPaidEmail(input: HostPaidEmailInput): HostPaidEmail {
  const guestName = displayText(input.guestName, 'Guest');
  const receiptTitle = displayText(input.receiptTitle, 'Receipt');
  const groupName = optionalText(input.groupName);
  const paid = formatGbpFromPence(input.paidAmountPence);
  const remainingPence = Number.isFinite(input.remainingBalancePence) ? Math.trunc(input.remainingBalancePence) : 0;
  const settled = remainingPence <= 0;
  const remaining = formatGbpFromPence(Math.max(0, remainingPence));
  const subject = settled
    ? `${guestName} paid ${paid} — ${receiptTitle} is now settled`
    : `${guestName} paid ${paid} for ${receiptTitle}`;
  const badge = settled ? 'SETTLED' : 'PAYMENT RECEIVED';
  const badgeColor = settled ? '#2EE59D' : '#7C8CFF';
  const safeGuest = escapeHtml(guestName);
  const safeReceipt = escapeHtml(receiptTitle);
  const safeGroup = groupName ? escapeHtml(groupName) : '';
  const safePaid = escapeHtml(paid);
  const safeRemaining = escapeHtml(remaining);
  const groupRow = groupName
    ? `<tr><td style="padding:8px 0;color:#7B849B;font-size:13px;font-family:Helvetica,Arial,sans-serif;">Group</td><td align="right" style="padding:8px 0;color:#F5F7FF;font-size:14px;font-family:Helvetica,Arial,sans-serif;">${safeGroup}</td></tr>`
    : '';
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#05060B;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05060B;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#121524;border:1px solid #24293D;border-radius:18px;">
<tr><td style="padding:28px 24px 8px 24px;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:3px;color:#F5F7FF;font-weight:700;">VELOR</td></tr>
<tr><td style="padding:8px 24px 0 24px;"><span style="display:inline-block;padding:6px 10px;border-radius:999px;border:1px solid ${badgeColor};color:${badgeColor};font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.8px;">${badge}</span></td></tr>
<tr><td style="padding:18px 24px 8px 24px;font-family:Helvetica,Arial,sans-serif;font-size:40px;line-height:44px;font-weight:700;color:#F5F7FF;">${safePaid}</td></tr>
<tr><td style="padding:8px 24px 24px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
<tr><td style="padding:8px 0;color:#7B849B;font-size:13px;font-family:Helvetica,Arial,sans-serif;">From</td><td align="right" style="padding:8px 0;color:#F5F7FF;font-size:14px;font-family:Helvetica,Arial,sans-serif;">${safeGuest}</td></tr>
<tr><td style="padding:8px 0;color:#7B849B;font-size:13px;font-family:Helvetica,Arial,sans-serif;">Bill</td><td align="right" style="padding:8px 0;color:#F5F7FF;font-size:14px;font-family:Helvetica,Arial,sans-serif;">${safeReceipt}</td></tr>
${groupRow}
<tr><td style="padding:8px 0;color:#7B849B;font-size:13px;font-family:Helvetica,Arial,sans-serif;">Remaining</td><td align="right" style="padding:8px 0;color:#F5F7FF;font-size:14px;font-family:Helvetica,Arial,sans-serif;">${safeRemaining}</td></tr>
</table>
</td></tr>
<tr><td style="padding:0 24px 24px 24px;color:#7B849B;font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;">Sent automatically by Velor</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
  const lines = [
    'VELOR',
    badge,
    paid,
    `From: ${guestName}`,
    `Bill: ${receiptTitle}`,
  ];
  if (groupName) lines.push(`Group: ${groupName}`);
  lines.push(`Remaining: ${remaining}`, '', 'Sent automatically by Velor');
  return { subject, html, text: lines.join('\n') };
}

function displayText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return fallback;
  return clean.slice(0, 120);
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  return clean.slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
