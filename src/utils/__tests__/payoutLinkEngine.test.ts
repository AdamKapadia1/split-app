import {
  amountToPence,
  assertAllowlistedPaymentUrl,
  buildExactAmountPaymentUrl,
  formatPoundsFromPence,
  validatePaymentHandle,
} from '../payoutLinkEngine';

const tests: { name: string; run: () => void }[] = [];

function it(name: string, run: () => void) {
  tests.push({ name, run });
}

function assertEqual(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right} but received ${left}`);
}

function assertThrows(run: () => void, message: string) {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message);
}

it('treats a blank handle as unset and rejects injection', () => {
  assertEqual(validatePaymentHandle(null), { valid: true, handle: null });
  assertEqual(validatePaymentHandle('  '), { valid: true, handle: null });
  assertEqual(validatePaymentHandle(' @Ada.Name '), { valid: true, handle: 'Ada.Name' });
  assertEqual(validatePaymentHandle('https://monzo.me/ada_name'), { valid: true, handle: 'ada_name' });
  assertEqual(validatePaymentHandle('https://monzo.me/ada_name/14.50').valid, false);
  assertEqual(validatePaymentHandle('john/../../evil').valid, false);
  assertEqual(validatePaymentHandle('javascript:alert(1)').valid, false);
  assertEqual(validatePaymentHandle('a').valid, false);
});

it('formats integer pence to two decimal places', () => {
  assertEqual(amountToPence(12.5), 1250);
  assertEqual(amountToPence(12.499), 1250);
  assertEqual(formatPoundsFromPence(1250), '12.50');
  assertEqual(formatPoundsFromPence(1), '0.01');
  assertEqual(buildExactAmountPaymentUrl('monzo', 'Ada.M', amountToPence(12.5)), 'https://monzo.me/Ada.M/12.50');
  assertThrows(() => formatPoundsFromPence(12.5), 'fractional pence');
  assertThrows(() => formatPoundsFromPence(0), 'zero pence');
});

it('keeps exact-amount URLs on https monzo.me and revolut.me', () => {
  const monzo = buildExactAmountPaymentUrl('monzo', 'Ada.M', 1450, 'Friday dinner');
  const revolut = buildExactAmountPaymentUrl('revolut', 'ada_m', 1450, 'House');
  assertEqual(monzo, 'https://monzo.me/Ada.M/14.50?d=Friday%20dinner');
  assertEqual(revolut, 'https://revolut.me/ada_m?amount=14.50&currency=GBP&note=House');
  assertEqual(new URL(monzo).protocol, 'https:');
  assertEqual(new URL(monzo).hostname, 'monzo.me');
  assertEqual(new URL(revolut).hostname, 'revolut.me');
  assertEqual(new URL(revolut).searchParams.get('amount'), '14.50');
  assertThrows(() => buildExactAmountPaymentUrl('monzo', 'john/../../evil', 1450), 'path injection');
  assertThrows(() => assertAllowlistedPaymentUrl('javascript:alert(1)', 'monzo'), 'javascript protocol');
  assertThrows(() => assertAllowlistedPaymentUrl('https://evil.example/monzo.me/Ada.M/14.50', 'monzo'), 'foreign host');
  assertThrows(() => assertAllowlistedPaymentUrl('http://monzo.me/Ada.M/14.50', 'monzo'), 'http protocol');
  assertThrows(() => assertAllowlistedPaymentUrl('https://www.monzo.me/Ada.M/14.50', 'monzo'), 'www host');
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
  throw new Error(`${failed} payout link engine test${failed === 1 ? '' : 's'} failed`);
}
