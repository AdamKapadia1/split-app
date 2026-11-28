// The app tsconfig has no Node types; a typed require keeps tsc happy.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs') as { readFileSync: (path: string, encoding: 'utf8') => string };

const MIGRATION = `${process.cwd()}/supabase/migrations/20261128120000_guest_sync_topic_and_email_claim.sql`;
const sql: string = fs.readFileSync(MIGRATION, 'utf8');
const code = sql
  .split('\n')
  .filter((line: string) => !line.trim().startsWith('--'))
  .join('\n');

const tests: { name: string; run: () => void }[] = [];

function it(name: string, run: () => void) {
  tests.push({ name, run });
}

function assertTrue(value: boolean, message: string) {
  if (!value) throw new Error(message);
}

function section(start: string, end: string): string {
  const from = code.indexOf(start);
  assertTrue(from >= 0, `missing ${start}`);
  const to = code.indexOf(end, from + start.length);
  assertTrue(to > from, `missing ${end} after ${start}`);
  return code.slice(from, to);
}

it('set_paid_status never writes host_notified_at (one email per share)', () => {
  const paid = section("IF p_action = 'set_paid_status' THEN", 'RETURN public.get_shared_bill(p_share_token);\n  END IF;');
  assertTrue(paid.includes('SET is_paid = v_paid'), 'still updates is_paid');
  assertTrue(!paid.includes('host_notified_at'), 'set_paid_status must not touch host_notified_at');
  assertTrue(!code.includes('host_notified_at'), 'no executable SQL in this migration touches host_notified_at');
});

it('every UPDATE has an explicit WHERE (pg_safeupdate)', () => {
  const updates = code.split(/\bUPDATE\s+public\./).slice(1);
  assertTrue(updates.length > 0, 'expected at least one UPDATE');
  for (const body of updates) {
    const statement = body.slice(0, body.indexOf(';'));
    assertTrue(/\bWHERE\b/.test(statement), `UPDATE without WHERE: ${statement.slice(0, 80)}`);
  }
});

it('is additive: functions are CREATE OR REPLACE, no drops or table changes', () => {
  assertTrue(!/\bDROP\b/i.test(code), 'no DROP statements');
  assertTrue(!/\bALTER\s+TABLE\b/i.test(code), 'no ALTER TABLE');
  const creates = code.match(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/g) ?? [];
  assertTrue(creates.length === 2, 'exactly two functions');
  assertTrue(creates.every((entry: string) => /OR\s+REPLACE/.test(entry)), 'every function uses CREATE OR REPLACE');
});

it('broadcasts on the receipt topic without the token, and keeps the legacy topic', () => {
  const trigger = section('FUNCTION public.broadcast_split_sync()', '$$;');
  assertTrue(trigger.includes("'split-sync:' || v_receipt::text"), 'sends to split-sync:<receipt_id>');
  const receiptSend = trigger.slice(0, trigger.indexOf("'split-sync:' || v_receipt::text"));
  const lastBuild = receiptSend.lastIndexOf('jsonb_build_object(');
  assertTrue(!receiptSend.slice(lastBuild).includes('share_token'), 'receipt payload has no share token');
  assertTrue(trigger.includes("'split-sync:' || v_token"), 'legacy token topic kept for shipped native builds');
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
  throw new Error(`${failed} migration test${failed === 1 ? '' : 's'} failed`);
}
