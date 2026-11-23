import { logger, redactSensitive } from '../logger';
import {
  MAX_RECEIPT_IMAGE_BYTES,
  assertReceiptImageByteLength,
  assertReceiptImagePath,
  buildReceiptImagePath,
  decodeBase64ToArrayBuffer,
  decodeReceiptImageBase64,
} from '../receiptImage';

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

function assertThrows(run: () => unknown, message: string) {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  assertTrue(threw, message);
}

const owner = '11111111-1111-4111-8111-111111111111';
const receipt = '22222222-2222-4222-8222-222222222222';
const storedPath = `${owner}/${receipt}.jpg`;

it('builds a lowercase uuid path and rejects traversal, urls, and other extensions', () => {
  assertEqual(buildReceiptImagePath(owner, receipt), storedPath);
  assertEqual(buildReceiptImagePath(owner.toUpperCase(), `  ${receipt}  `), storedPath);
  assertEqual(assertReceiptImagePath(storedPath), storedPath);

  const rejected = [
    '../etc/passwd',
    `${owner}/../${receipt}.jpg`,
    `../${owner}/${receipt}.jpg`,
    `/${owner}/${receipt}.jpg`,
    `https://evil.example/${storedPath}`,
    `http://evil.example/${storedPath}`,
    `${owner}/${receipt}.png`,
    `${owner}/${receipt}.jpeg`,
    `${owner}/${receipt}.JPG`,
    `${owner}/${receipt}.jpg/extra`,
    `${owner}\\${receipt}.jpg`,
    `${owner}/${receipt}.jpg?token=secret`,
    '',
    owner,
    receipt,
  ];

  for (const path of rejected) {
    assertThrows(() => assertReceiptImagePath(path), `accepted unsafe path ${path}`);
  }

  for (const userId of ['../etc/passwd', `${owner}/../secret`, 'not-a-uuid', `${owner}/../../`, 'https://evil.example/a.jpg']) {
    assertThrows(() => buildReceiptImagePath(userId, receipt), `accepted unsafe user id ${userId}`);
  }

  assertThrows(() => buildReceiptImagePath(owner, '../secret'), 'accepted unsafe receipt id');
  assertThrows(() => buildReceiptImagePath('not-a-uuid', receipt), 'accepted a non-uuid user');
  assertThrows(() => buildReceiptImagePath(`${owner}/../../`, receipt), 'accepted a slashed user id');
});

it('decodes base64 into bytes and rejects empty or oversized images before upload', () => {
  const decoded = decodeBase64ToArrayBuffer('YQ==');
  assertEqual(decoded.byteLength, 1);
  assertEqual(new Uint8Array(decoded)[0], 97);

  const fromDataUri = decodeReceiptImageBase64('data:image/jpeg;base64,YQ==');
  assertEqual(new Uint8Array(fromDataUri)[0], 97);

  const urlSafe = decodeBase64ToArrayBuffer('YQ');
  assertEqual(new Uint8Array(urlSafe)[0], 97);

  assertEqual(decodeBase64ToArrayBuffer('').byteLength, 0);
  assertEqual(decodeBase64ToArrayBuffer('   ').byteLength, 0);
  assertThrows(() => decodeReceiptImageBase64(''), 'accepted an empty image');
  assertThrows(() => decodeReceiptImageBase64('   '), 'accepted a blank image');
  assertThrows(() => assertReceiptImageByteLength(0), 'accepted 0 bytes');
  assertThrows(() => assertReceiptImageByteLength(-1), 'accepted a negative length');
  assertThrows(() => assertReceiptImageByteLength(1.5), 'accepted a fractional length');
  assertThrows(() => assertReceiptImageByteLength(MAX_RECEIPT_IMAGE_BYTES + 1), 'accepted an image over 5 MB');
  assertEqual(assertReceiptImageByteLength(MAX_RECEIPT_IMAGE_BYTES), undefined);

  const groups = Math.ceil((MAX_RECEIPT_IMAGE_BYTES + 1) / 3);
  assertThrows(
    () => decodeReceiptImageBase64('A'.repeat(groups * 4)),
    'decoded an image over 5 MB',
  );
  assertThrows(() => decodeBase64ToArrayBuffer('@@@@'), 'accepted invalid base64');
  assertThrows(() => decodeBase64ToArrayBuffer('Y==='), 'accepted malformed padding');
});

it('never logs a signed receipt url', () => {
  const signedUrl = `https://project.supabase.co/storage/v1/object/sign/receipt-images/${storedPath}?token=eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3MDAwMDAwMDB9.signaturevalue`;
  const redacted = redactSensitive({
    signedUrl,
    note: `open ${signedUrl}`,
    nested: { signed_url: signedUrl },
  });
  const redactedDump = JSON.stringify(redacted);
  assertTrue(!redactedDump.includes('token='), 'token query survived redaction');
  assertTrue(!redactedDump.includes('eyJhbGci'), 'jwt survived redaction');
  assertTrue(!redactedDump.includes('/object/sign/'), 'signed url survived redaction');
  assertTrue(!redactedDump.includes('signaturevalue'), 'signature survived redaction');

  const calls: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    logger.warn('receipt image', signedUrl, { signedUrl });
  } finally {
    console.warn = original;
  }

  const dumped = JSON.stringify(calls);
  assertTrue(calls.length === 1, 'warning was not emitted');
  assertTrue(!dumped.includes('token='), 'logger wrote the token query');
  assertTrue(!dumped.includes('eyJhbGci'), 'logger wrote the jwt');
  assertTrue(!dumped.includes('/object/sign/'), 'logger wrote the signed url');
  assertTrue(!dumped.includes('signaturevalue'), 'logger wrote the signature');
  assertTrue(!dumped.includes(storedPath), 'logger wrote the object path from the signed url');
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
  throw new Error(`${failed} receipt image test${failed === 1 ? '' : 's'} failed`);
}
