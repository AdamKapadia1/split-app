import {
  buildFasterPaymentReference,
  buildMonzoPayUrl,
  buildRevolutPayUrl,
  formatBankDetailsSummary,
  formatHandleAmountCopy,
  formatUkSortCode,
  isHttpsUrl,
  normalizeUkHandle,
  resolveUkPaymentRails,
  sortCodeDigits,
  ukAccountNumber,
} from '../ukPaymentRails';

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

it('strips @, spaces, and payment URL prefixes from handles', () => {
  assertEqual(normalizeUkHandle('  @Ada.Name '), 'Ada.Name');
  assertEqual(normalizeUkHandle('https://monzo.me/@ada_name'), 'ada_name');
  assertEqual(normalizeUkHandle('https://revolut.me/ada-lane/extra'), 'ada-lane');
  assertEqual(normalizeUkHandle('javascript:alert(1)'), null);
  assertEqual(normalizeUkHandle('ada name'), null);
  assertEqual(normalizeUkHandle('a'), null);
});

it('builds a Monzo link only for a positive amount on https', () => {
  assertEqual(
    buildMonzoPayUrl('https://monzo.me/@Ada.Name', 1450, 'Friday dinner'),
    'https://monzo.me/Ada.Name/14.50?d=Friday%20dinner',
  );
  assertEqual(buildMonzoPayUrl('Ada.Name', 0, 'Dinner'), null);
  assertEqual(buildMonzoPayUrl('not a handle', 1450), null);
  assertTrue(isHttpsUrl('https://monzo.me/Ada.Name/14.50'), 'monzo https');
  assertEqual(isHttpsUrl('http://monzo.me/Ada.Name/14.50'), false);
  assertEqual(isHttpsUrl('javascript:alert(1)'), false);
});

it('builds a Revolut profile link and a clipboard pair', () => {
  assertEqual(buildRevolutPayUrl('@ada_name'), 'https://revolut.me/ada_name');
  assertEqual(buildRevolutPayUrl('https://revolut.me/ada_name?amount=9.99'), 'https://revolut.me/ada_name');
  assertEqual(buildRevolutPayUrl('http://revolut.me/ada_name'), 'https://revolut.me/ada_name');
  assertEqual(buildRevolutPayUrl('http://evil.example/ada_name'), null);
  assertTrue(isHttpsUrl(buildRevolutPayUrl('@ada_name') ?? ''), 'revolut link is https');
  assertEqual(formatHandleAmountCopy('ada_name', '£14.50'), '@ada_name\n£14.50');
});

it('formats sort code, account number, and an 18-character reference', () => {
  assertEqual(formatUkSortCode('12 34 56'), '12-34-56');
  assertEqual(sortCodeDigits('12-34-56'), '123456');
  assertEqual(formatUkSortCode('12345'), null);
  assertEqual(ukAccountNumber('1234 5678'), '12345678');
  assertEqual(ukAccountNumber('1234567'), null);
  assertEqual(buildFasterPaymentReference('ab_cd-12!!'), 'VELOR-ABCD12');
  const longRef = buildFasterPaymentReference('A'.repeat(40));
  assertEqual(longRef.length <= 18, true);
  assertEqual(/^[A-Z0-9-]{1,18}$/.test(longRef), true);
  assertEqual(longRef.startsWith('VELOR-'), true);
});

it('copies a readable Faster Payments summary and exposes every configured rail', () => {
  const summary = formatBankDetailsSummary({
    recipient: 'Ada Lane',
    sortCodeDisplay: '12-34-56',
    accountNumber: '12345678',
    amountLabel: '£14.50',
    reference: 'VELOR-ABCD12',
  });
  assertEqual(
    summary,
    'Recipient: Ada Lane\nSort Code: 12-34-56\nAccount Number: 12345678\nAmount: £14.50\nReference: VELOR-ABCD12',
  );

  const rails = resolveUkPaymentRails({
    monzoHandle: '@ada.m',
    revolutHandle: 'https://revolut.me/ada_r',
    bankAccountName: 'Ada Lane',
    bankSortCode: '123456',
    bankAccountNumber: '12345678',
    amountPence: 1450,
    amountLabel: '£14.50',
    referenceSource: 'token_abcd12',
  });
  assertEqual(rails.monzo?.url, 'https://monzo.me/ada.m/14.50?d=VELOR-TOKENABCD12');
  assertEqual(rails.revolut?.url, 'https://revolut.me/ada_r');
  assertEqual(rails.revolut?.copyText, '@ada_r\n£14.50');
  assertEqual(rails.bank?.sortCodeDisplay, '12-34-56');
  assertEqual(rails.bank?.sortCodeDigits, '123456');
  assertEqual(rails.bank?.accountNumber, '12345678');
  assertTrue(!summary.includes('••••'), 'account number must not be masked');
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
  throw new Error(`${failed} UK payment rail test${failed === 1 ? '' : 's'} failed`);
}
