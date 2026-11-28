// Source-level guards for Build 13. These files import the React Native
// Supabase client, so they are checked as text rather than executed.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
  readdirSync: (path: string, options: { withFileTypes: true }) => { name: string; isDirectory: () => boolean }[];
};

const ROOT = process.cwd();
const service = fs.readFileSync(`${ROOT}/src/services/BillShareService.ts`, 'utf8');

const tests: { name: string; run: () => void }[] = [];

function it(name: string, run: () => void) {
  tests.push({ name, run });
}

function assertTrue(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function methodBody(name: string): string {
  const start = service.indexOf(`  async ${name}(`);
  assertTrue(start >= 0, `missing method ${name}`);
  const next = service.indexOf('\n  async ', start + 1);
  const end = next >= 0 ? next : service.indexOf('\n}\n', start);
  return service.slice(start, end);
}

/** Drops // and /* *\/ comments so only executable text is checked. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

it('fetchHostClaims and fetchSharedBill go through the bounded read retry', () => {
  for (const name of ['fetchHostClaims', 'fetchSharedBill']) {
    assertTrue(methodBody(name).includes('runReadRpc('), `${name} must use runReadRpc`);
  }
});

it('no mutating RPC is ever retried', () => {
  const mutating = ['enableBillShare', 'revokeBillShare', 'mutateSharedBill', 'setHostClaims', 'confirmHostItems'];
  for (const name of mutating) {
    const body = methodBody(name);
    assertTrue(!body.includes('runReadRpc') && !body.includes('readRpcWithRetry'), `${name} must not retry`);
  }
  const retryUses = (stripComments(service).match(/runReadRpc\(/g) ?? []).length;
  assertTrue(retryUses === 2, `expected exactly 2 retried reads, found ${retryUses}`);
});

it('src/ makes no runtime call to claim_push_token', () => {
  const offenders = sourceFiles(`${ROOT}/src`).filter((file) => stripComments(fs.readFileSync(file, 'utf8')).includes('claim_push_token'));
  assertTrue(offenders.length === 0, `claim_push_token still called in: ${offenders.join(', ')}`);
});

it('startup no longer imports or calls registerPushToken', () => {
  const layout = stripComments(fs.readFileSync(`${ROOT}/src/app/_layout.tsx`, 'utf8'));
  assertTrue(!/\bregisterPushToken\b/.test(layout), '_layout still references registerPushToken');
  const push = stripComments(fs.readFileSync(`${ROOT}/src/services/PushNotificationService.ts`, 'utf8'));
  assertTrue(!/export\s+async\s+function\s+registerPushToken\b/.test(push), 'registerPushToken is still exported');
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

if (failed > 0) throw new Error(`${failed} build 13 guard test${failed === 1 ? '' : 's'} failed`);
