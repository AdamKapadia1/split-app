import { act, createElement, type ReactNode } from 'react';

import { useReceiptLedgerRealtime } from '../useReceiptLedgerRealtime';
import { useSplitRealtime } from '../useSplitRealtime';
import {
  bindUniqueChannel,
  createInvalidationScheduler,
  resetRealtimeForTests,
  type RealtimeChannelLike,
  type RealtimeClientLike,
} from '../safeRealtimeChannel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalError = console.error.bind(console);
const originalWarn = console.warn.bind(console);
function hideRendererNotice(args: unknown[]) {
  const text = args.map((arg) => (typeof arg === 'string' ? arg : '')).join(' ');
  return text.includes('react-test-renderer is deprecated') || text.includes('not configured to support act');
}
console.error = (...args: unknown[]) => {
  if (hideRendererNotice(args)) return;
  originalError(...args);
};
console.warn = (...args: unknown[]) => {
  if (hideRendererNotice(args)) return;
  originalWarn(...args);
};

type ReactTestRenderer = {
  unmount: () => void;
};

let createRenderer: ((element: ReactNode) => ReactTestRenderer) | null = null;

async function renderTree(element: ReactNode) {
  if (!createRenderer) {
    const loaded = await import('react-test-renderer') as { create: (node: ReactNode) => ReactTestRenderer };
    createRenderer = loaded.create;
  }
  return createRenderer(element);
}

const SHARE_TOKEN = 'abcdefghijklmnopqrst';

const tests: { name: string; run: () => void | Promise<void> }[] = [];

function it(name: string, run: () => void | Promise<void>) {
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

type FakeChannel = RealtimeChannelLike & {
  topic: string;
  joined: boolean;
};

function createFakeClient(mode: 'ok' | 'subscribe-throws' = 'ok') {
  const calls: string[] = [];
  const unsubscribed: string[] = [];
  const removed: string[] = [];
  const channels = new Map<string, FakeChannel>();

  const client: RealtimeClientLike = {
    channel(topic) {
      calls.push(topic);
      const existing = channels.get(topic);
      if (existing) return existing;
      const channel: FakeChannel = {
        topic,
        joined: false,
        on() {
          if (channel.joined) {
            throw new Error(`cannot add \`postgres_changes\` callbacks for realtime:${topic} after \`subscribe()\`.`);
          }
          return channel;
        },
        subscribe(callback) {
          if (mode === 'subscribe-throws') throw new Error('socket unavailable');
          if (channel.joined) {
            throw new Error("tried to join multiple times. 'join' can only be called a single time per channel instance");
          }
          channel.joined = true;
          callback?.('SUBSCRIBED');
          return channel;
        },
        unsubscribe() {
          channel.joined = false;
          unsubscribed.push(topic);
          return 'ok';
        },
      };
      channels.set(topic, channel);
      return channel;
    },
    removeChannel(channel) {
      const topic = 'topic' in channel && typeof channel.topic === 'string' ? channel.topic : '';
      removed.push(topic);
      channels.delete(topic);
      return 'ok';
    },
  };

  return { calls, unsubscribed, removed, client };
}

function Home({ client }: { client: RealtimeClientLike }) {
  useReceiptLedgerRealtime(() => undefined, null, client);
  return null;
}

function Groups({ client }: { client: RealtimeClientLike }) {
  useReceiptLedgerRealtime(() => undefined, null, client);
  return null;
}

function GroupDetail({ client }: { client: RealtimeClientLike }) {
  useReceiptLedgerRealtime(() => undefined, 'group-1', client);
  return null;
}

function SplitScreen({ client, receiptId }: { client: RealtimeClientLike; receiptId: string | null }) {
  useSplitRealtime(SHARE_TOKEN, () => undefined, receiptId, client);
  return null;
}

function MountedTabs({ client }: { client: RealtimeClientLike }) {
  return createElement(
    'div',
    null,
    createElement(Home, { client }),
    createElement(Groups, { client }),
    createElement(GroupDetail, { client }),
    createElement(SplitScreen, { client, receiptId: 'receipt-1' }),
    createElement(SplitScreen, { client, receiptId: null }),
  ) as ReactNode;
}

it('gives every mounted ledger and split screen a distinct channel and unsubscribes cleanly', async () => {
  resetRealtimeForTests();
  const fake = createFakeClient();
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = await renderTree(createElement(MountedTabs, { client: fake.client }));
  });

  const logical = `split-sync:${SHARE_TOKEN}`;
  const receiptTopics = fake.calls.filter((topic) => topic.startsWith('receipt-status:'));
  const splitInstances = fake.calls.filter((topic) => topic.startsWith(`${logical}:`));
  assertEqual(receiptTopics.length, 3);
  assertEqual(new Set(receiptTopics).size, 3);
  assertEqual(receiptTopics.filter((topic) => topic.includes(':visible:')).length, 2);
  assertEqual(receiptTopics.filter((topic) => topic.includes(':group-1:')).length, 1);
  assertEqual(splitInstances.length, 2);
  assertEqual(new Set(splitInstances).size, 2);
  assertEqual(fake.calls.filter((topic) => topic === logical).length, 1);
  assertEqual(new Set(fake.calls).size, fake.calls.length);

  act(() => {
    renderer?.unmount();
  });
  assertEqual([...fake.unsubscribed].sort(), [...fake.calls].sort());
  assertEqual([...fake.removed].sort(), [...fake.calls].sort());
});

it('keeps a screen mounted when channel.subscribe throws', async () => {
  resetRealtimeForTests();
  const fake = createFakeClient('subscribe-throws');
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = await renderTree(createElement(Home, { client: fake.client }));
  });
  act(() => {
    renderer?.unmount();
  });
  assertTrue(fake.calls.length === 1, 'the hook still attempted its own channel');
});

it('catches a synchronous subscribe failure without rethrowing', () => {
  resetRealtimeForTests();
  const fake = createFakeClient('subscribe-throws');
  let close = () => undefined as void;
  assertTrue((() => {
    close = bindUniqueChannel(fake.client, {
      topic: 'receipt-status:visible:test:1',
      bind(channel) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table: 'receipts' }, () => undefined);
      },
    });
    return true;
  })(), 'bindUniqueChannel should not throw');
  close();
});

it('drops invalidation scheduled after unmount and coalesces a burst', async () => {
  let calls = 0;
  const scheduler = createInvalidationScheduler(() => {
    calls += 1;
  }, 0);
  scheduler.schedule();
  scheduler.schedule();
  scheduler.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(calls, 0);

  const live = createInvalidationScheduler(() => {
    calls += 1;
  }, 0);
  live.schedule();
  live.schedule();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(calls, 1);
  live.dispose();

  const throwing = createInvalidationScheduler(() => {
    throw new Error('listener failed');
  }, 0);
  throwing.schedule();
  await new Promise((resolve) => setTimeout(resolve, 0));
  throwing.dispose();
});

async function run() {
  let failed = 0;
  for (const test of tests) {
    try {
      await test.run();
      process.stdout.write(`ok ${test.name}\n`);
    } catch (error) {
      failed += 1;
      process.stderr.write(`not ok ${test.name}\n`);
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : 'unknown test failure'}\n`);
    }
  }
  if (failed > 0) {
    process.stderr.write(`${failed} realtime test${failed === 1 ? '' : 's'} failed\n`);
    process.exitCode = 1;
  }
}

void run();
