import {
  clearPendingPayment,
  confirmationFailure,
  endConfirm,
  formatPendingAmount,
  PENDING_PAYMENT_TTL_MS,
  readPendingPayment,
  reconcilePendingPayment,
  resetPendingPaymentStorageForTests,
  safeSessionStorage,
  tryAcquireLocks,
  tryBeginConfirm,
  withPaidFlag,
  writePendingPayment,
  type PendingPaymentRecord,
} from '../pendingPaymentReturn';

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

const SHARE = 'abcdefghijklmnopqrst';
const GUEST = 'guest-1';

function record(overrides: Partial<PendingPaymentRecord> = {}): PendingPaymentRecord {
  return {
    provider: 'Monzo',
    shareToken: SHARE,
    guestId: GUEST,
    amountPence: 1250,
    amountFormatted: '12.50',
    startedAt: Date.now(),
    ...overrides,
  };
}

it('falls back to memory when sessionStorage throws SecurityError', () => {
  resetPendingPaymentStorageForTests();
  const previousWindow = globalThis.window;
  let attempts = 0;
  const throwing = {
    getItem() {
      attempts += 1;
      throw new Error('SecurityError');
    },
    setItem() {
      attempts += 1;
      throw new Error('SecurityError');
    },
    removeItem() {
      attempts += 1;
      throw new Error('SecurityError');
    },
  };
  globalThis.window = { sessionStorage: throwing } as unknown as Window & typeof globalThis.window;
  try {
    safeSessionStorage.setItem('velor:test', 'kept');
    assertEqual(safeSessionStorage.getItem('velor:test'), 'kept');
    assertTrue(attempts >= 1, 'the restricted store was attempted');
    const after = attempts;
    assertEqual(safeSessionStorage.getItem('velor:test'), 'kept');
    assertEqual(attempts, after);
    safeSessionStorage.removeItem('velor:test');
    assertEqual(safeSessionStorage.getItem('velor:test'), null);
  } finally {
    globalThis.window = previousWindow;
    resetPendingPaymentStorageForTests();
  }
});

it('discards corrupted and expired pending payments', () => {
  resetPendingPaymentStorageForTests();
  const previousWindow = globalThis.window;
  globalThis.window = undefined as unknown as Window & typeof globalThis.window;
  try {
    safeSessionStorage.setItem(`velor:pending-payment:${SHARE}:${GUEST}`, '{');
    assertEqual(readPendingPayment(SHARE, GUEST), null);
    assertEqual(safeSessionStorage.getItem(`velor:pending-payment:${SHARE}:${GUEST}`), null);

    writePendingPayment(record({ startedAt: Date.now() - PENDING_PAYMENT_TTL_MS - 1 }));
    assertEqual(readPendingPayment(SHARE, GUEST), null);

    const fresh = record();
    writePendingPayment(fresh);
    assertEqual(readPendingPayment(SHARE, GUEST)?.provider, 'Monzo');
    assertEqual(formatPendingAmount(1250), '12.50');
  } finally {
    globalThis.window = previousWindow;
    resetPendingPaymentStorageForTests();
  }
});

it('clears a pending payment once the share is already paid', () => {
  resetPendingPaymentStorageForTests();
  const previousWindow = globalThis.window;
  globalThis.window = undefined as unknown as Window & typeof globalThis.window;
  try {
    writePendingPayment(record());
    const decision = reconcilePendingPayment({ shareToken: SHARE, guestId: GUEST, shareIsPaid: true });
    assertEqual(decision, { pending: null, showPrompt: false });
    assertEqual(readPendingPayment(SHARE, GUEST), null);
    clearPendingPayment(SHARE, GUEST);
  } finally {
    globalThis.window = previousWindow;
    resetPendingPaymentStorageForTests();
  }
});

it('lets a double tap start only one confirmation', () => {
  const lock = { current: false };
  let mutations = 0;
  function confirm() {
    if (!tryBeginConfirm(lock)) return;
    mutations += 1;
  }
  confirm();
  confirm();
  assertEqual(mutations, 1);
  assertTrue(lock.current, 'the in-flight lock stays held');
  endConfirm(lock);
  assertTrue(!lock.current, 'the lock releases after the mutation settles');
});

it('rolls a failed confirmation back to the previous unpaid share', () => {
  const previous = [{ id: GUEST, isPaid: false, paidAt: null }];
  const optimistic = withPaidFlag(previous, GUEST, true, '2026-11-27T22:00:00.000Z');
  assertEqual(optimistic[0]?.isPaid, true);
  const pending = record();
  const failure = confirmationFailure(previous, pending);
  assertEqual(failure.bill[0]?.isPaid, false);
  assertEqual(failure.bill[0]?.paidAt, null);
  assertEqual(failure.pending, pending);
  assertTrue(failure.error.length > 0, 'retry copy is present');
});

// These mirror the exact lock calls in src/app/s/[token].tsx:
//   setPaid:                tryAcquireLocks([busy], [confirmingRef])
//   confirmReturnedPayment: tryAcquireLocks([confirmingRef, busy])
function screenLocks() {
  return { busy: { current: false }, confirming: { current: false } };
}

it('blocks "Yes, I\'ve paid" while an Undo holds busy', () => {
  const locks = screenLocks();
  const undo = tryAcquireLocks([locks.busy], [locks.confirming]);
  assertTrue(undo !== null, 'undo takes busy');
  const confirm = tryAcquireLocks([locks.confirming, locks.busy]);
  assertEqual(confirm, null);
  assertEqual(locks.confirming.current, false);
  assertEqual(locks.busy.current, true);
  undo?.();
  assertEqual(locks.busy.current, false);
});

it('blocks an Undo while "Yes, I\'ve paid" is in flight', () => {
  const locks = screenLocks();
  const confirm = tryAcquireLocks([locks.confirming, locks.busy]);
  assertTrue(confirm !== null, 'confirm takes both locks');
  assertEqual(locks.busy.current, true);
  assertEqual(locks.confirming.current, true);
  assertEqual(tryAcquireLocks([locks.busy], [locks.confirming]), null);
  confirm?.();
  assertEqual(locks.busy.current, false);
  assertEqual(locks.confirming.current, false);
});

it('a refused caller can never clear a lock it does not own', () => {
  const locks = screenLocks();
  const owner = tryAcquireLocks([locks.busy]);
  const refused = tryAcquireLocks([locks.confirming, locks.busy]);
  assertEqual(refused, null);
  assertEqual(locks.busy.current, true);
  owner?.();
  owner?.();
  const next = tryAcquireLocks([locks.busy]);
  assertTrue(next !== null, 'lock is free again after one release');
  // A stale double release from the first owner must not free the new holder.
  owner?.();
  assertEqual(locks.busy.current, true);
  next?.();
  assertEqual(locks.busy.current, false);
});

it('takes no lock at all when only one of several is free', () => {
  const locks = screenLocks();
  locks.confirming.current = true;
  assertEqual(tryAcquireLocks([locks.confirming, locks.busy]), null);
  assertEqual(locks.busy.current, false);
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
  throw new Error(`${failed} pending payment test${failed === 1 ? '' : 's'} failed`);
}
