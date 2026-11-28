import { readSafeErrorCode } from '../errorMapper';

const tests: { name: string; run: () => void }[] = [];

function it(name: string, run: () => void) {
  tests.push({ name, run });
}

function assertEqual(actual: unknown, expected: unknown) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`expected ${right} but received ${left}`);
}

it('accepts every 5-character SQLSTATE, PostgREST, and symbolic codes', () => {
  for (const code of ['22023', '57014', '40P01', '40001', '21000', '23503', 'P0001', '42501', 'PGRST301', 'PGRST202', 'FAILED', 'UPSTREAM_ERROR']) {
    assertEqual(readSafeErrorCode({ code }, 'FALLBACK'), code);
  }
});

it('prefers a nested SQLSTATE when the wrapper code is not safe', () => {
  assertEqual(readSafeErrorCode({ code: 'not safe', originalError: { code: '57014' } }, 'FALLBACK'), '57014');
});

it('rejects emails, sentences, lowercase, punctuation, and wrong lengths', () => {
  const rejected = [
    'ada@example.com',
    'invalid share token',
    'Network request failed',
    'failed',
    '22p02',
    'pgrst301',
    '22-02',
    '2202',
    '220233',
    '07700900123',
    '12-34-56',
    '£12.50',
    'A',
    '',
    ' 22023',
    '22023 ',
    'X'.repeat(41),
  ];
  for (const code of rejected) {
    assertEqual(readSafeErrorCode({ code }, 'FALLBACK'), 'FALLBACK');
  }
});

it('never reads the message, details, or hint', () => {
  const error = { code: '', message: 'ada@example.com owes £12.50', details: 'sort code 12-34-56', hint: 'token abcdefghijklmnopqrst' };
  assertEqual(readSafeErrorCode(error, ''), '');
  assertEqual(readSafeErrorCode(new Error('22023'), 'FALLBACK'), 'FALLBACK');
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

if (failed > 0) throw new Error(`${failed} error mapper test${failed === 1 ? '' : 's'} failed`);
