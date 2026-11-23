import { redactSensitive, shouldEmitLog } from '../logger';
import { mapErrorToUserMessage, readSafeErrorCode } from '../errorMapper';

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

it('redacts sensitive keys recursively', () => {
  const redacted = redactSensitive({
    email: 'ada@example.com',
    password: 'hunter2',
    token: 'raw-token',
    access_token: 'access',
    refresh_token: 'refresh',
    authorization: 'Bearer abc',
    sort_code: '123456',
    account_number: '12345678',
    bank_sort_code: '654321',
    bank_account_number: '87654321',
    nested: {
      Email: 'other@example.com',
      SORT_CODE: '112233',
      note: 'Meet at the cafe',
    },
    rows: [{ access_token: 'hidden', merchant: 'Tesco' }],
  }) as {
    email: string;
    nested: { Email: string; note: string };
    rows: { merchant: string; access_token: string }[];
  };

  assertEqual(redacted.email, '[redacted]');
  assertEqual(redacted.nested.Email, '[redacted]');
  assertEqual(redacted.nested.note, 'Meet at the cafe');
  assertEqual(redacted.rows[0].merchant, 'Tesco');
  assertEqual(redacted.rows[0].access_token, '[redacted]');
  assertTrue(!JSON.stringify(redacted).includes('ada@example.com'), 'email value leaked');
  assertTrue(!JSON.stringify(redacted).includes('12345678'), 'account number leaked');
});

it('redacts emails and JWTs inside strings', () => {
  const redacted = redactSensitive('login ada@example.com with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue');
  assertTrue(typeof redacted === 'string' && !redacted.includes('ada@example.com'), 'email remained in string');
  assertTrue(typeof redacted === 'string' && !redacted.includes('eyJhbGci'), 'jwt remained in string');
});

it('strips stacks from errors and keeps a redacted message', () => {
  const error = new Error('failed for ada@example.com');
  const redacted = redactSensitive(error) as { name: string; message: string; stack?: string };
  assertEqual(redacted.name, 'Error');
  assertTrue(redacted.message.includes('[redacted]'), 'email was not redacted');
  assertTrue(redacted.stack === undefined, 'stack was included');
});

it('silences debug and info outside development', () => {
  const previous = (globalThis as { __DEV__?: boolean }).__DEV__;
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  assertEqual(shouldEmitLog('debug'), false);
  assertEqual(shouldEmitLog('info'), false);
  assertEqual(shouldEmitLog('warn'), true);
  assertEqual(shouldEmitLog('error'), true);
  (globalThis as { __DEV__?: boolean }).__DEV__ = true;
  assertEqual(shouldEmitLog('debug'), true);
  (globalThis as { __DEV__?: boolean }).__DEV__ = previous;
});

it('maps database errors without schema details', () => {
  const unique = mapErrorToUserMessage({
    code: '23505',
    message: 'duplicate key value violates unique constraint "profiles_email_key"',
  });
  const denied = mapErrorToUserMessage({
    code: '42501',
    message: 'permission denied for table user_payout_methods',
  });
  const missing = mapErrorToUserMessage({
    code: 'PGRST116',
    message: 'JSON object requested, multiple (or no) rows returned',
  });
  assertEqual(unique, 'That is already saved.');
  assertEqual(denied, 'You do not have permission to do that.');
  assertEqual(missing, 'We could not find that.');
  assertTrue(!unique.includes('profiles'), 'table name leaked');
  assertTrue(!denied.includes('user_payout_methods'), 'table name leaked');
});

it('maps timeouts, auth, and network failures', () => {
  assertEqual(mapErrorToUserMessage(new Error('Request timeout of 10000ms exceeded')), 'The request timed out. Check your connection and try again.');
  assertEqual(mapErrorToUserMessage({ code: '28000', message: 'Not authenticated' }), 'Please sign in again.');
  assertEqual(mapErrorToUserMessage(new TypeError('Failed to fetch')), 'Network problem. Check your connection and try again.');
});

it('logs a permission failure by stage code without the database text', () => {
  const wrapped = {
    code: 'INSERT_FAILED',
    message: 'You do not have permission to do that.',
    originalError: {
      code: '42501',
      message: 'new row violates row-level security policy for table "receipts"',
    },
  };
  assertEqual(readSafeErrorCode(wrapped, 'PARSE_FAILED'), '42501');
  assertEqual(readSafeErrorCode({ code: 'UPSTREAM_ERROR', message: 'ada@example.com' }, 'PARSE_FAILED'), 'UPSTREAM_ERROR');
  assertEqual(readSafeErrorCode(new Error('relation "public.receipts" does not exist'), 'PARSE_FAILED'), 'PARSE_FAILED');
  assertTrue(!readSafeErrorCode(wrapped).includes('receipts'), 'relation leaked into the code');
});

it('keeps authored copy and hides raw postgres text', () => {
  assertEqual(mapErrorToUserMessage(new Error('Enter a valid phone number.')), 'Enter a valid phone number.');
  const hidden = mapErrorToUserMessage(new Error('relation "public.receipts" does not exist'));
  assertEqual(hidden, 'Something went wrong. Please try again.');
  assertTrue(!hidden.includes('receipts'), 'relation leaked');
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
  throw new Error(`${failed} security util test${failed === 1 ? '' : 's'} failed`);
}
