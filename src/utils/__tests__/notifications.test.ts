import { mapSettlementNudgeError } from '../errorMapper';
import { redactSensitive } from '../logger';
import {
  createNudgeIdempotencyKey,
  formatSettlementNudgeBody,
  isExpoPushToken,
  NUDGE_COOLDOWN_MS,
  nudgeCooldown,
  receiptIdFromNotificationData,
  SENDER_HOURLY_CAP,
  SENDER_WINDOW_MS,
  senderCapReached,
  senderWindowCount,
} from '../notifications';

const tests: { name: string; run: () => void }[] = [];

function it(name: string, run: () => void) {
  tests.push({ name, run });
}

function assertEqual(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right} but received ${left}`);
}

function assertTrue(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ID = '22222222-2222-4222-8222-222222222222';

it('accepts Expo push tokens and rejects malformed ones', () => {
  assertTrue(isExpoPushToken('ExponentPushToken[abcDEF_123-xyz]'), 'exponent token should pass');
  assertTrue(isExpoPushToken('ExpoPushToken[abcDEF_123-xyz]'), 'expo token should pass');
  assertTrue(!isExpoPushToken('ExponentPushToken[]'), 'empty token should fail');
  assertTrue(!isExpoPushToken('ExponentPushToken[abc def]'), 'spaces should fail');
  assertTrue(!isExpoPushToken('ExponentPushToken[abc.def]'), 'dots should fail');
  assertTrue(!isExpoPushToken('prefix-ExponentPushToken[abc]'), 'prefix should fail');
  assertTrue(!isExpoPushToken('ExponentPushToken[abc]/../../etc'), 'path should fail');
});

it('keeps a 24 hour cooldown and releases it on the boundary', () => {
  const now = Date.parse('2026-11-24T12:00:00.000Z');
  const cooling = nudgeCooldown(now - NUDGE_COOLDOWN_MS + 1000, now);
  assertEqual(cooling.active, true);
  assertEqual(cooling.nextAllowedAt, new Date(now + 1000).toISOString());
  const released = nudgeCooldown(now - NUDGE_COOLDOWN_MS, now);
  assertEqual(released.active, false);
  assertEqual(released.nextAllowedAt, null);
});

it('caps a sender at 10 nudges in a rolling hour', () => {
  const now = Date.parse('2026-11-24T12:00:00.000Z');
  const inside = Array.from({ length: SENDER_HOURLY_CAP }, () => now - 60_000);
  assertEqual(senderWindowCount(inside, now), 10);
  assertTrue(senderCapReached(inside, now), '10 nudges in the hour should stop the next one');
  assertTrue(!senderCapReached(inside.slice(0, 9), now), '9 nudges should still be allowed');
  const expired = [...inside.slice(0, 9), now - SENDER_WINDOW_MS];
  assertEqual(senderWindowCount(expired, now), 9);
  assertTrue(!senderCapReached(expired, now), 'a nudge exactly one hour old is outside the window');
});

it('hides the amount and merchant on the lock screen when asked', () => {
  const shown = formatSettlementNudgeBody({
    senderFirstName: 'Ada Lovelace',
    amountPence: 1248,
    merchantName: 'Tesco 12-34-56 12345678',
    hideAmounts: false,
  });
  assertEqual(shown, 'Ada sent a friendly reminder for £12.48 (Tesco)');
  assertTrue(!shown.includes('Lovelace'), 'surname leaked');
  assertTrue(!shown.includes('12-34-56'), 'sort code leaked');
  assertTrue(!shown.includes('12345678'), 'account number leaked');

  const hidden = formatSettlementNudgeBody({
    senderFirstName: 'Ada Lovelace',
    amountPence: 1248,
    merchantName: 'Tesco',
    hideAmounts: true,
  });
  assertEqual(hidden, 'Ada sent you a friendly settlement reminder');
  assertTrue(!hidden.includes('12.48'), 'amount leaked');
  assertTrue(!hidden.includes('Tesco'), 'merchant leaked');
});

it('accepts only a bare receipt UUID from a settlement nudge', () => {
  assertEqual(receiptIdFromNotificationData({ type: 'settlement_nudge', receiptId: RECEIPT_ID }), RECEIPT_ID);
  assertEqual(receiptIdFromNotificationData({ type: 'settlement_nudge', receiptId: `../${RECEIPT_ID}` }), null);
  assertEqual(receiptIdFromNotificationData({ type: 'settlement_nudge', receiptId: `${RECEIPT_ID}/admin` }), null);
  assertEqual(receiptIdFromNotificationData({ type: 'settlement_nudge', receiptId: '..%2F..%2Fetc' }), null);
  assertEqual(receiptIdFromNotificationData({ type: 'other', receiptId: RECEIPT_ID }), null);
  assertEqual(receiptIdFromNotificationData({ type: 'settlement_nudge', receiptId: 'not-a-uuid' }), null);
});

it('builds a stable idempotency key for one tap', () => {
  const first = createNudgeIdempotencyKey(RECEIPT_ID, RECIPIENT_ID, 'tap123');
  const second = createNudgeIdempotencyKey(RECEIPT_ID, RECIPIENT_ID, 'tap123');
  assertEqual(first, second);
  assertTrue(first.startsWith('nudge:'), 'key prefix missing');
  assertTrue(!first.includes(' '), 'key should stay compact');
});

it('redacts Expo push tokens in logs', () => {
  const redacted = redactSensitive('registered ExponentPushToken[abcDEF_123-xyz] for ExpoPushToken[zzz]') as string;
  assertTrue(!redacted.includes('ExponentPushToken'), 'exponent token leaked');
  assertTrue(!redacted.includes('ExpoPushToken'), 'expo token leaked');
  assertTrue(!redacted.includes('abcDEF_123-xyz'), 'token secret leaked');
  const keyed = redactSensitive({ expo_push_token: 'ExponentPushToken[abc]', note: 'ok' }) as { expo_push_token: string; note: string };
  assertEqual(keyed.expo_push_token, '[redacted]');
  assertEqual(keyed.note, 'ok');
});

it('maps nudge failures to friendly copy', () => {
  assertEqual(mapSettlementNudgeError({ code: 'NUDGE_COOLDOWN' }), 'You already sent a reminder about this bill in the last 24 hours.');
  assertEqual(mapSettlementNudgeError({ code: 'RATE_LIMITED' }), 'You have sent too many reminders. Please try again in an hour.');
  assertEqual(mapSettlementNudgeError({ code: 'RECIPIENT_OPTED_OUT' }), 'This person has turned off settlement reminders.');
  assertEqual(mapSettlementNudgeError({ code: 'NO_REGISTERED_DEVICE' }), 'This person does not have notifications set up on a device yet.');
  const hidden = mapSettlementNudgeError(new Error('relation "public.settlement_nudges" does not exist'));
  assertTrue(!hidden.includes('settlement_nudges'), 'table name leaked');
});

let failed = 0;
for (const test of tests) {
  try {
    test.run();
    process.stdout.write(`ok ${test.name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`not ok ${test.name}\n`);
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : 'unknown test failure'}\n`);
  }
}

if (failed > 0) {
  throw new Error(`${failed} notification test${failed === 1 ? '' : 's'} failed`);
}
