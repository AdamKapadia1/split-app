import {
  buildHostPaidEmail,
  constantTimeEqual,
  escapeHtml,
  formatGbpFromPence,
  isUnpaidToPaidTransition,
  type WebhookPayload,
} from '../hostPaidEmail';

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

function transition(oldPaid: unknown, newPaid: unknown): WebhookPayload {
  return {
    type: 'UPDATE',
    table: 'receipt_share_participants',
    record: { is_paid: newPaid },
    old_record: { is_paid: oldPaid },
  };
}

it('rejects mismatched, different-length, and empty secrets', () => {
  assertTrue(constantTimeEqual('velor-secret', 'velor-secret'), 'equal secrets match');
  assertTrue(!constantTimeEqual('velor-secret', 'velor-secreT'), 'case mismatch');
  assertTrue(!constantTimeEqual('abc', 'ab'), 'different length');
  assertTrue(!constantTimeEqual('', ''), 'empty strings');
  assertTrue(!constantTimeEqual('', 'secret'), 'empty provided');
  assertTrue(!constantTimeEqual('secret', ''), 'empty expected');
  assertTrue(constantTimeEqual('café', 'café'), 'utf-8 match');
  assertTrue(!constantTimeEqual('café', 'cafe'), 'utf-8 mismatch');
});

it('accepts only an unpaid to paid share update', () => {
  assertTrue(isUnpaidToPaidTransition(transition(false, true)), 'unpaid to paid');
  assertTrue(!isUnpaidToPaidTransition(transition(true, true)), 'paid to paid');
  assertTrue(!isUnpaidToPaidTransition(transition(false, false)), 'unpaid to unpaid');
  assertTrue(!isUnpaidToPaidTransition(transition(true, false)), 'paid to unpaid');
  assertTrue(!isUnpaidToPaidTransition({ type: 'INSERT', table: 'receipt_share_participants', record: { is_paid: true }, old_record: { is_paid: false } }), 'insert');
  assertTrue(!isUnpaidToPaidTransition({ type: 'UPDATE', table: 'receipts', record: { is_paid: true }, old_record: { is_paid: false } }), 'wrong table');
  assertTrue(!isUnpaidToPaidTransition({ type: 'UPDATE', table: 'receipt_share_participants', record: { is_paid: 'true' }, old_record: { is_paid: false } }), 'string flag');
  assertTrue(!isUnpaidToPaidTransition({}), 'malformed');
});

it('escapes html metacharacters', () => {
  const hostile = `<script>alert("x")</script>`;
  const escaped = escapeHtml(hostile);
  assertTrue(!escaped.includes('<script'), 'script tag removed');
  assertTrue(escaped.includes('&lt;script&gt;'), 'brackets escaped');
  assertTrue(escaped.includes('&quot;x&quot;'), 'double quotes escaped');
  assertEqual(escapeHtml(`Fish & Chips`), 'Fish &amp; Chips');
  assertEqual(escapeHtml(`O'Neil`), 'O&#39;Neil');
});

it('formats integer pence as pounds', () => {
  assertEqual(formatGbpFromPence(1250), '£12.50');
  assertEqual(formatGbpFromPence(50), '£0.50');
  assertEqual(formatGbpFromPence(0), '£0.00');
  assertEqual(formatGbpFromPence(Number.NaN), '£0.00');
});

it('builds a partial payment email with an optional group', () => {
  const email = buildHostPaidEmail({
    guestName: `<script>alert("x")</script>`,
    receiptTitle: `Fish & Chips`,
    groupName: `O'Neil House`,
    paidAmountPence: 1250,
    remainingBalancePence: 400,
  });
  assertEqual(email.subject, `<script>alert("x")</script> paid £12.50 for Fish & Chips`);
  assertTrue(email.html.includes('PAYMENT RECEIVED'), 'partial badge');
  assertTrue(email.html.includes('#7C8CFF'), 'iris badge');
  assertTrue(email.html.includes('#05060B'), 'obsidian shell');
  assertTrue(email.html.includes('#121524'), 'brushed surface');
  assertTrue(email.html.includes('VELOR'), 'wordmark');
  assertTrue(email.html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'), 'guest escaped');
  assertTrue(email.html.includes('Fish &amp; Chips'), 'title escaped');
  assertTrue(email.html.includes('O&#39;Neil House'), 'group escaped');
  assertTrue(email.html.includes('£12.50'), 'paid figure');
  assertTrue(email.html.includes('£4.00'), 'remaining');
  assertTrue(email.html.includes('Sent automatically by Velor'), 'footer');
  assertTrue(!email.html.includes('<script'), 'raw script absent');
  assertTrue(email.text.includes('From: <script>alert("x")</script>'), 'plain guest');
  assertTrue(email.text.includes('Group: O\'Neil House'), 'plain group');
  assertTrue(email.text.includes('Remaining: £4.00'), 'plain remaining');
});

it('builds a settled email and omits a blank group', () => {
  const email = buildHostPaidEmail({
    guestName: 'Ada',
    receiptTitle: 'Nando\'s',
    groupName: '   ',
    paidAmountPence: 1250,
    remainingBalancePence: 0,
  });
  assertEqual(email.subject, `Ada paid £12.50 — Nando's is now settled`);
  assertTrue(email.html.includes('SETTLED'), 'settled badge');
  assertTrue(email.html.includes('#2EE59D'), 'emerald badge');
  assertTrue(!email.html.includes('>Group<'), 'group row omitted');
  assertTrue(!email.text.includes('Group:'), 'plain group omitted');
  assertTrue(email.text.includes('Remaining: £0.00'), 'zero remaining');
  assertTrue(email.text.includes('Sent automatically by Velor'), 'plain footer');
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
  throw new Error(`${failed} host paid email test${failed === 1 ? '' : 's'} failed`);
}
