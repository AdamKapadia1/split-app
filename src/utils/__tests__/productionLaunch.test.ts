import { getWebBaseUrl } from '../../lib/url';
import {
  decideHostPaidNotification,
  formatGbpFromPence,
  formatSharePaidNotification,
  isAllowedPaymentRoute,
  isSharePaidTransition,
  receiptIdFromPaymentData,
} from '../hostPaidNotification';

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

const SHARE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECEIPT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GUEST_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const paidRecord = {
  id: SHARE_ID,
  receipt_id: RECEIPT_ID,
  user_id: null,
  display_name: 'Sam',
  is_paid: true,
  amount_owed_pence: 1250,
};

it('strips trailing slashes and falls back to velor-pay.vercel.app', () => {
  assertEqual(getWebBaseUrl({ EXPO_PUBLIC_WEB_URL: 'https://velor-pay.vercel.app/' }), 'https://velor-pay.vercel.app');
  assertEqual(getWebBaseUrl({ EXPO_PUBLIC_WEB_URL: 'https://velor-pay.vercel.app/share/' }), 'https://velor-pay.vercel.app/share');
  assertEqual(getWebBaseUrl({}), 'https://velor-pay.vercel.app');
  assertEqual(getWebBaseUrl({ EXPO_PUBLIC_WEB_URL: '   ' }), 'https://velor-pay.vercel.app');
  assertEqual(
    getWebBaseUrl({ EXPO_PUBLIC_WEB_URL: '', EXPO_PUBLIC_WEB_BASE_URL: 'https://preview.velor-pay.vercel.app/' }),
    'https://preview.velor-pay.vercel.app',
  );
});

it('rejects non-https origins in production', () => {
  const production = { NODE_ENV: 'production', EXPO_PUBLIC_APP_ENV: 'production' };
  assertEqual(getWebBaseUrl({ ...production, EXPO_PUBLIC_WEB_URL: 'http://localhost:8081' }), 'https://velor-pay.vercel.app');
  assertEqual(getWebBaseUrl({ ...production, EXPO_PUBLIC_WEB_URL: 'http://velor-pay.vercel.app' }), 'https://velor-pay.vercel.app');
  assertEqual(getWebBaseUrl({ ...production, EXPO_PUBLIC_WEB_URL: 'not a url' }), 'https://velor-pay.vercel.app');
  assertEqual(getWebBaseUrl({ ...production, EXPO_PUBLIC_WEB_URL: 'https://velor-pay.vercel.app/' }), 'https://velor-pay.vercel.app');
  assertEqual(getWebBaseUrl({ EXPO_PUBLIC_WEB_URL: 'http://localhost:8081' }), 'http://localhost:8081');
});

it('allows only the receipt bill route', () => {
  const route = `/receipt/${RECEIPT_ID}`;
  assertTrue(isAllowedPaymentRoute(route), 'receipt route should pass');
  assertEqual(receiptIdFromPaymentData({ route, billId: RECEIPT_ID }), RECEIPT_ID);
  assertEqual(receiptIdFromPaymentData({ route, billId: SHARE_ID }), null);
  assertEqual(receiptIdFromPaymentData({ route: `/bill/${RECEIPT_ID}` }), null);
  assertEqual(receiptIdFromPaymentData({ route: `/s/${SHARE_ID}` }), null);
  assertEqual(receiptIdFromPaymentData({ route: `/receipt/${RECEIPT_ID}/edit` }), null);
  assertEqual(receiptIdFromPaymentData({ route: `/receipt/${RECEIPT_ID}?next=/` }), null);
  assertEqual(receiptIdFromPaymentData({ route: 'https://velor-pay.vercel.app/receipt/' + RECEIPT_ID }), null);
});

it('notifies only when a share moves from unpaid to paid', () => {
  const base = {
    type: 'UPDATE',
    table: 'receipt_share_participants',
    record: paidRecord,
    oldRecord: { ...paidRecord, is_paid: false },
  };
  assertTrue(isSharePaidTransition(base), 'false to true should notify');
  assertEqual(decideHostPaidNotification(base, HOST_ID).action, 'notify');
  assertEqual(isSharePaidTransition({ ...base, type: 'INSERT', oldRecord: null }), false);
  assertEqual(isSharePaidTransition({ ...base, oldRecord: { ...paidRecord, is_paid: true } }), false);
  assertEqual(isSharePaidTransition({ ...base, record: { ...paidRecord, is_paid: false } }), false);
  assertEqual(isSharePaidTransition({ ...base, table: 'receipts' }), false);
  assertEqual(
    decideHostPaidNotification({ ...base, record: { ...paidRecord, user_id: HOST_ID } }, HOST_ID).action,
    'ignore',
  );
  assertEqual(
    decideHostPaidNotification({ ...base, record: { ...paidRecord, user_id: GUEST_ID } }, HOST_ID).action,
    'notify',
  );
  assertEqual(
    decideHostPaidNotification({
      ...base,
      record: { ...paidRecord, is_host: true, user_id: GUEST_ID },
    }, HOST_ID).action,
    'ignore',
  );
  assertEqual(
    decideHostPaidNotification({
      ...base,
      record: { ...paidRecord, is_host: true, user_id: null },
    }, HOST_ID).action,
    'ignore',
  );
  assertEqual(
    decideHostPaidNotification({
      ...base,
      record: { ...paidRecord, is_host: false, user_id: null },
      oldRecord: { ...paidRecord, is_paid: false, is_host: true, user_id: HOST_ID },
    }, HOST_ID).action,
    'ignore',
  );
  assertEqual(
    decideHostPaidNotification({
      ...base,
      record: { ...paidRecord, is_host: false, user_id: GUEST_ID },
    }, HOST_ID).action,
    'notify',
  );
});

it('formats pence as GBP and builds the receipt deep link', () => {
  assertEqual(formatGbpFromPence(1250), '£12.50');
  assertEqual(formatGbpFromPence(10), '£0.10');
  const message = formatSharePaidNotification({
    guestName: 'Sam',
    amountPence: 1250,
    venue: 'The Eagle',
    receiptId: RECEIPT_ID,
    shareId: SHARE_ID,
  });
  assertEqual(message?.title, 'Payment received');
  assertEqual(message?.body, 'Sam marked £12.50 as paid for The Eagle');
  assertEqual(message?.data.route, `/receipt/${RECEIPT_ID}`);
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
  throw new Error(`${failed} production launch test${failed === 1 ? '' : 's'} failed`);
}
