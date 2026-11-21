import {
  buildPaymentUrl,
  buildProfilePreviewUrl,
  formatSortCode,
  getProviderLimitWarning,
  maskAccountNumber,
  normalizeAccountNumber,
  normalizeSortCode,
  parsePastedPaymentLink,
  sanitizePaymentHandle,
  sanitizeReference,
} from '../paymentLinks';

const tests: { name: string; run: () => void }[] = [];

function it(name: string, run: () => void) {
  tests.push({ name, run });
}

function assertEqual(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error(`expected ${right} but received ${left}`);
  }
}

function assertTrue(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function assertThrows(run: () => void, message: string) {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  assertTrue(threw, message);
}

it('rejects path, query, and homoglyph injection in a payment handle', () => {
  assertEqual(sanitizePaymentHandle('monzo', 'john/../../evil'), null);
  assertEqual(sanitizePaymentHandle('monzo', 'john?amount=9999'), null);
  assertEqual(sanitizePaymentHandle('revolut', 'john&amount=1'), null);
  assertEqual(sanitizePaymentHandle('paypal', 'john#frag'), null);
  assertEqual(sanitizePaymentHandle('monzo', 'jo\nhn'), null);
  assertEqual(sanitizePaymentHandle('monzo', 'j\u043Ehn'), null);
  assertEqual(sanitizePaymentHandle('monzo', 'https://monzo.me/Ada.Name'), 'Ada.Name');
  assertEqual(sanitizePaymentHandle('revolut', '@ada_name'), 'ada_name');
  assertEqual(sanitizePaymentHandle('paypal', '  paypal.me/Adam1  '), 'Adam1');
});

it('lets Monzo and Revolut use punctuation that PayPal rejects', () => {
  assertEqual(sanitizePaymentHandle('paypal', 'ada-m'), null);
  assertEqual(sanitizePaymentHandle('paypal', 'ada.m'), null);
  assertEqual(sanitizePaymentHandle('paypal', 'ada_m'), null);
  assertEqual(sanitizePaymentHandle('paypal', 'ad'), 'ad');
  assertEqual(sanitizePaymentHandle('monzo', 'ada-m'), 'ada-m');
  assertEqual(sanitizePaymentHandle('monzo', 'ada.m'), 'ada.m');
  assertEqual(sanitizePaymentHandle('monzo', 'ada_m'), 'ada_m');
  assertEqual(sanitizePaymentHandle('revolut', 'ada-m.name_1'), 'ada-m.name_1');
  assertEqual(sanitizePaymentHandle('paypal', 'a'), null);
  assertEqual(sanitizePaymentHandle('monzo', 'a'), null);
});

it('builds https payment URLs from integer pence and rejects unsafe amounts', () => {
  assertEqual(buildPaymentUrl('monzo', 'Ada.M', 1450, 'Friday dinner'), 'https://monzo.me/Ada.M/14.50?d=Friday%20dinner');
  assertEqual(buildPaymentUrl('monzo', 'Ada.M', 1450), 'https://monzo.me/Ada.M/14.50');
  assertEqual(
    buildPaymentUrl('revolut', 'ada_m', 1450, 'House'),
    'https://revolut.me/ada_m?amount=14.50&currency=GBP&note=House',
  );
  assertEqual(buildPaymentUrl('revolut', 'ada_m', 1450), 'https://revolut.me/ada_m?amount=14.50&currency=GBP');
  assertEqual(buildPaymentUrl('paypal', 'Adam1', 1450), 'https://paypal.me/Adam1/14.50GBP');

  assertThrows(() => buildPaymentUrl('monzo', 'Ada.M', 0), 'zero pence');
  assertThrows(() => buildPaymentUrl('monzo', 'Ada.M', -50), 'negative pence');
  assertThrows(() => buildPaymentUrl('monzo', 'Ada.M', 10.5), 'fractional pence');
  assertThrows(() => buildPaymentUrl('paypal', 'Ada.M', 1_000_001), 'above the safety cap');
  assertThrows(() => buildPaymentUrl('paypal', 'ada-m', 1450), 'paypal punctuation');
  assertThrows(() => buildPaymentUrl('monzo', 'john/../../evil', 1450), 'path injection');
});

it('warns below £1, above £100, and above £250', () => {
  const monzo = 'Monzo.me card payments are limited to £1–£100 for non-Monzo users. Use bank transfer if this fails.';
  const revolut = 'Card payments via Revolut.me are capped at £250/week.';
  assertEqual(getProviderLimitWarning('monzo', 99), monzo);
  assertEqual(getProviderLimitWarning('monzo', 100), null);
  assertEqual(getProviderLimitWarning('monzo', 10_000), null);
  assertEqual(getProviderLimitWarning('monzo', 10_001), monzo);
  assertEqual(getProviderLimitWarning('revolut', 25_000), null);
  assertEqual(getProviderLimitWarning('revolut', 25_001), revolut);
  assertEqual(getProviderLimitWarning('paypal', 99), null);
  assertEqual(getProviderLimitWarning('paypal', 25_001), null);
});

it('sanitizes a Faster Payments reference and caps it at 35 characters', () => {
  assertEqual(sanitizeReference(undefined), '');
  assertEqual(sanitizeReference('  Friday   dinner \n'), 'Friday dinner');
  assertEqual(sanitizeReference('House?bill#1&tax=2'), 'House bill 1 tax 2');
  assertEqual(sanitizeReference('a'.repeat(40)).length, 35);
  assertEqual(sanitizeReference('a'.repeat(40)), 'a'.repeat(35));
});

it('reads a pasted provider link and rejects anything off the allow list', () => {
  assertEqual(parsePastedPaymentLink('https://monzo.me/john.doe'), { provider: 'monzo', handle: 'john.doe' });
  assertEqual(parsePastedPaymentLink('revolut.me/@jane_1'), { provider: 'revolut', handle: 'jane_1' });
  assertEqual(parsePastedPaymentLink('https://paypal.me/alex99/10GBP'), { provider: 'paypal', handle: 'alex99' });
  assertEqual(parsePastedPaymentLink('https://www.monzo.me/john.doe'), { provider: 'monzo', handle: 'john.doe' });
  assertEqual(parsePastedPaymentLink('https://evil-monzo.me/john'), null);
  assertEqual(parsePastedPaymentLink('javascript:alert(1)'), null);
  assertEqual(parsePastedPaymentLink('https://paypal.me/bad-name'), null);
  assertEqual(parsePastedPaymentLink('https://monzo.me/john/../../evil'), null);
  assertEqual(parsePastedPaymentLink(''), null);
  assertEqual(parsePastedPaymentLink(`https://monzo.me/${'a'.repeat(250)}`), null);
});

it('builds a profile preview URL and rejects an invalid handle', () => {
  assertEqual(buildProfilePreviewUrl('monzo', 'john.doe'), 'https://monzo.me/john.doe');
  assertEqual(buildProfilePreviewUrl('revolut', '@jane_1'), 'https://revolut.me/jane_1');
  assertEqual(buildProfilePreviewUrl('paypal', 'alex99'), 'https://paypal.me/alex99');
  assertThrows(() => buildProfilePreviewUrl('paypal', 'bad-name'), 'paypal punctuation');
  assertThrows(() => buildProfilePreviewUrl('monzo', 'john/../../evil'), 'path injection');
});

it('normalizes and masks UK bank details', () => {
  assertEqual(normalizeSortCode('12-34-56'), '123456');
  assertEqual(normalizeSortCode('12 34 56'), '123456');
  assertEqual(normalizeSortCode('12345'), null);
  assertEqual(normalizeSortCode('1234567'), null);
  assertEqual(formatSortCode('123456'), '12-34-56');
  assertEqual(normalizeAccountNumber('1234 5678'), '12345678');
  assertEqual(normalizeAccountNumber('1234567'), null);
  assertEqual(maskAccountNumber('12345678'), '••••5678');
  assertThrows(() => formatSortCode('12345'), 'short sort code');
  assertThrows(() => maskAccountNumber('1234'), 'short account number');
});

let failed = 0;
for (const test of tests) {
  try {
    test.run();
    console.log(`ok ${test.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok ${test.name}`);
    console.error(error);
  }
}

if (failed > 0) {
  throw new Error(`${failed} payment link test${failed === 1 ? '' : 's'} failed`);
}
