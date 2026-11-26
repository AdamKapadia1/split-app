import { computeHomeBalances } from '../homeBalances';
import {
  canMarkSharePaid,
  hostClaimProgress,
  hostPayerPillLabel,
  hostSettledShareCopy,
  isHostParticipant,
  outstandingOwedToHostPence,
  payerAttributionLine,
  publicHostLabel,
  resolveHostDisplayName,
  selectNamePrompt,
  whoAreYouPrompt,
} from '../hostAttribution';
import { reconcileSharedBill } from '../sharedSplitMath';

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

it('prefers a public first name, then full name, then Host', () => {
  assertEqual(resolveHostDisplayName({ firstName: ' Ada ', fullName: 'Ada Lovelace' }), 'Ada');
  assertEqual(resolveHostDisplayName({ firstName: 'ada@mail.com', fullName: 'Ada Lovelace' }), 'Ada Lovelace');
  assertEqual(resolveHostDisplayName({ firstName: 'Dbd512', fullName: 'Ada Lovelace' }), 'Ada Lovelace');
  assertEqual(resolveHostDisplayName({ firstName: '07700900123', fullName: '12-34-56' }), 'Host');
  assertEqual(resolveHostDisplayName({ storedName: 'Sam' }), 'Sam');
  assertEqual(resolveHostDisplayName({ storedName: 'Host' }), 'Host');
  assertEqual(resolveHostDisplayName({ storedName: '  ' }), 'Host');
  assertEqual(resolveHostDisplayName({}), 'Host');
  assertEqual(publicHostLabel('Ada@hidden.com'), 'Host');
  assertEqual(publicHostLabel('Ada'), 'Ada');
});

it('labels the payer without asking a guest to tap a generic Host pill', () => {
  assertEqual(payerAttributionLine('Ada'), 'Paid outright by Ada');
  assertEqual(hostPayerPillLabel('Ada'), 'Ada · Paid');
  assertEqual(hostPayerPillLabel('not-a-name@x.com'), 'Host · Paid');
  assertEqual(
    whoAreYouPrompt('Ada'),
    'Tap your name (or add yourself) and select what you had to see what you owe Ada.',
  );
  assertEqual(selectNamePrompt('Ada'), 'Select your name to see what you owe Ada.');
});

it('recognises a legacy Host row and refuses a pay action for the payer', () => {
  assertTrue(isHostParticipant({ isHost: true, displayName: 'Ada', isGuest: false }), 'flagged host');
  assertTrue(isHostParticipant({ displayName: 'Host', isGuest: false }), 'legacy host label');
  assertTrue(isHostParticipant({ userId: 'host', displayName: 'Ada' }, 'host'), 'owner id');
  assertTrue(!isHostParticipant({ isHost: false, displayName: 'Host', isGuest: false }), 'explicit guest named Host');
  assertTrue(!isHostParticipant({ displayName: 'Host', isGuest: true }), 'guest flag wins');
  assertTrue(!canMarkSharePaid({ isHost: true, displayName: 'Ada' }), 'host cannot mark paid');
  assertTrue(!canMarkSharePaid({ displayName: 'Host', isGuest: false }), 'legacy host cannot mark paid');
  assertTrue(canMarkSharePaid({ isHost: false, displayName: 'Sam', isGuest: true }), 'guest can mark paid');
  assertEqual(hostSettledShareCopy('£4.00'), {
    title: 'Your share: £4.00 · Paid outright',
    subtitle: 'You paid the full bill — your share is already settled.',
  });
});

it('keeps the host share out of owed-to-host totals', () => {
  assertEqual(outstandingOwedToHostPence([
    { userId: 'host', amountPence: 4000, isHost: true },
    { userId: 'sam', amountPence: 6000 },
    { userId: 'bea', amountPence: 250, settled: true },
    { userId: 'cam', amountPence: 10.5 },
  ], 'host'), 6000);

  assertEqual(outstandingOwedToHostPence([
    { userId: 'host', amountPence: 4000 },
    { userId: 'sam', amountPence: 1500 },
  ], 'host'), 1500);

  const home = computeHomeBalances([{
    id: 'receipt-1',
    hostId: 'host',
    paidBy: 'host',
    createdAt: '2026-11-01T00:00:00.000Z',
    shares: [
      { userId: 'host', displayName: 'Ada', amountPence: 4000 },
      { userId: 'sam', displayName: 'Sam', amountPence: 6000 },
    ],
  }], 'host');
  assertEqual(home.owedToYouPence, 6000);
  assertEqual(home.youOwePence, 0);
});

it('lets the host pre-claim an item and still split it with a guest', () => {
  const items = [
    { id: 'meal', pricePence: 1001 },
    { id: 'drink', pricePence: 500 },
  ];
  const exclusive = hostClaimProgress({
    items,
    hostId: 'host',
    claims: [{ itemId: 'meal', participantId: 'host' }],
    participantIds: ['host', 'guest'],
    totalPence: 1501,
    serviceChargePence: 0,
  });
  assertEqual(exclusive.itemsClaimed, 1);
  assertEqual(exclusive.itemsTotal, 2);
  assertEqual(exclusive.hostOwedPence, 1001);
  assertEqual(exclusive.unclaimedPence, 500);

  const shared = reconcileSharedBill({
    items,
    claims: [
      { itemId: 'meal', participantId: 'host' },
      { itemId: 'meal', participantId: 'guest' },
    ],
    participantIds: ['host', 'guest'],
    totalPence: 1501,
    serviceChargePence: 0,
  });
  assertEqual(shared.amountOwed.host, 500);
  assertEqual(shared.amountOwed.guest, 501);
  assertEqual(shared.amountOwed.host + shared.amountOwed.guest + shared.unclaimedPence, 1501);
  assertEqual(shared.unclaimedPence, 500);

  const withService = reconcileSharedBill({
    items: [{ id: 'meal', pricePence: 1000 }],
    claims: [
      { itemId: 'meal', participantId: 'host' },
      { itemId: 'meal', participantId: 'guest' },
    ],
    participantIds: ['host', 'guest'],
    totalPence: 1100,
    serviceChargePence: 100,
  });
  assertEqual(withService.amountOwed.host + withService.amountOwed.guest, 1100);
  assertEqual(withService.serviceCharge.host, 50);
  assertEqual(withService.serviceCharge.guest, 50);
  assertEqual(withService.unclaimedPence, 0);
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
  throw new Error(`${failed} host attribution test${failed === 1 ? '' : 's'} failed`);
}
