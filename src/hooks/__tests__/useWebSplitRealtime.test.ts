import { act, createElement, useEffect, type ReactNode } from 'react';

import { resetRealtimeForTests, type RealtimeChannelLike, type RealtimeClientLike } from '../safeRealtimeChannel';
import { useWebSplitRealtime, WEB_REALTIME_POLL_MS, type WebRealtimeStatus } from '../useWebSplitRealtime';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { __DEV__?: boolean }).__DEV__ = true;

const originalError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const text = args.map((arg) => (typeof arg === 'string' ? arg : '')).join(' ');
  if (text.includes('react-test-renderer is deprecated') || text.includes('not configured to support act')) return;
  if (text.includes('web-realtime') || text.includes('SUBSCRIBE_FAILED') || text.includes('socket unavailable')) return;
  originalError(...args);
};

type ReactTestRenderer = { unmount: () => void };
let createRenderer: ((element: ReactNode) => ReactTestRenderer) | null = null;

async function renderTree(element: ReactNode) {
  if (!createRenderer) {
    const loaded = await import('react-test-renderer') as { create: (node: ReactNode) => ReactTestRenderer };
    createRenderer = loaded.create;
  }
  return createRenderer(element);
}

const SHARE = 'abcdefghijklmnopqrst';
const RECEIPT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

type Handler = () => void;

type FakeChannel = RealtimeChannelLike & {
  topic: string;
  joined: boolean;
  handlers: Handler[];
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
      if (existing?.joined) {
        throw new Error('tried to join multiple times');
      }
      if (existing) return existing;
      const channel: FakeChannel = {
        topic,
        joined: false,
        handlers: [],
        on(_type, _filter, callback) {
          if (channel.joined) throw new Error('cannot add postgres_changes callbacks after subscribe()');
          channel.handlers.push(() => {
            callback();
          });
          return channel;
        },
        subscribe(callback) {
          if (mode === 'subscribe-throws') throw new Error('socket unavailable');
          if (channel.joined) throw new Error('tried to join multiple times');
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

  return { calls, unsubscribed, removed, channels, client };
}

type Listener = (event: { persisted?: boolean }) => void;

function installBrowser(visibility: 'visible' | 'hidden') {
  const listeners = new Map<string, Set<Listener>>();
  const browser = {
    visibilityState: visibility,
    addEventListener(type: string, handler: Listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
    },
    removeEventListener(type: string, handler: Listener) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type: string, event: { persisted?: boolean } = {}) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler(event);
    },
  };
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = browser as unknown as Document;
  globalThis.window = browser as unknown as Window & typeof globalThis.window;
  return {
    browser,
    restore() {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
    },
  };
}

function Screen({
  client,
  onRefresh,
  onStatus,
}: {
  client: RealtimeClientLike;
  onRefresh: (isCurrent: () => boolean) => void | Promise<void>;
  onStatus?: (status: WebRealtimeStatus) => void;
}) {
  const status = useWebSplitRealtime({
    shareToken: SHARE,
    receiptId: RECEIPT,
    client,
    onRefresh,
  });
  useEffect(() => {
    onStatus?.(status);
  }, [onStatus, status]);
  return null;
}

it('gives strict-mode mounts distinct topics and tears them down', async () => {
  resetRealtimeForTests();
  const browser = installBrowser('visible');
  const fake = createFakeClient();
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = await renderTree(createElement(
        'div',
        null,
        createElement(Screen, { client: fake.client, onRefresh: () => undefined }),
        createElement(Screen, { client: fake.client, onRefresh: () => undefined }),
      ));
    });
    const topics = fake.calls.filter((topic) => topic.startsWith(`web-split:${SHARE}:`));
    assertTrue(topics.length >= 2, 'each mount opens its own topic');
    assertEqual(new Set(topics).size, topics.length);
    assertTrue(topics.every((topic) => topic.includes('-')), 'topic carries a random suffix');
    act(() => {
      renderer?.unmount();
    });
    for (const topic of topics) {
      assertTrue(fake.unsubscribed.includes(topic), `missing unsubscribe for ${topic}`);
      assertTrue(fake.removed.includes(topic), `missing removeChannel for ${topic}`);
    }
  } finally {
    browser.restore();
  }
});

it('degrades when subscribe throws', async () => {
  resetRealtimeForTests();
  const browser = installBrowser('visible');
  const fake = createFakeClient('subscribe-throws');
  const seen: WebRealtimeStatus[] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = await renderTree(createElement(Screen, {
        client: fake.client,
        onRefresh: () => undefined,
        onStatus: (status) => {
          seen.push(status);
        },
      }));
    });
    assertEqual(seen[seen.length - 1], 'DEGRADED');
    act(() => {
      renderer?.unmount();
    });
    const topics = fake.calls.filter((topic) => topic.startsWith('web-split:'));
    assertTrue(topics.every((topic) => fake.unsubscribed.includes(topic)), 'failed subscribe still unsubscribes');
    assertTrue(topics.every((topic) => fake.removed.includes(topic)), 'failed subscribe still removes the channel');
  } finally {
    browser.restore();
  }
});

it('refetches and reconnects on visibility, bfcache restore, and online while degraded', async () => {
  resetRealtimeForTests();
  const browser = installBrowser('visible');
  const fake = createFakeClient('subscribe-throws');
  let refreshes = 0;
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = await renderTree(createElement(Screen, {
        client: fake.client,
        onRefresh: () => {
          refreshes += 1;
        },
      }));
    });
    const before = fake.calls.filter((topic) => topic.startsWith('web-split:')).length;
    browser.browser.dispatch('pageshow', { persisted: false });
    assertEqual(refreshes, 0);
    await act(async () => {
      browser.browser.dispatch('visibilitychange');
    });
    await act(async () => {
      browser.browser.dispatch('pageshow', { persisted: true });
    });
    await act(async () => {
      browser.browser.dispatch('online');
    });
    assertEqual(refreshes, 3);
    const after = fake.calls.filter((topic) => topic.startsWith('web-split:')).length;
    assertTrue(after >= before + 3, 'each degraded wake opens a fresh topic');
    act(() => {
      renderer?.unmount();
    });
  } finally {
    browser.restore();
  }
});

it('coalesces a realtime burst and drops a stale response', async () => {
  resetRealtimeForTests();
  const browser = installBrowser('visible');
  const fake = createFakeClient();
  let refreshes = 0;
  const pending: (() => void)[] = [];
  const applied: boolean[] = [];
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = await renderTree(createElement(Screen, {
        client: fake.client,
        onRefresh: (isCurrent) => new Promise<void>((resolve) => {
          refreshes += 1;
          pending.push(() => {
            applied.push(isCurrent());
            resolve();
          });
        }),
      }));
    });
    const topic = fake.calls.find((entry) => entry.startsWith('web-split:'));
    const channel = topic ? fake.channels.get(topic) : undefined;
    assertTrue(Boolean(channel && channel.handlers.length >= 3), 'shares, claims, and the receipt are bound');
    await act(async () => {
      for (let index = 0; index < 5; index += 1) channel?.handlers[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    assertEqual(refreshes, 1);

    await act(async () => {
      browser.browser.dispatch('visibilitychange');
      browser.browser.dispatch('visibilitychange');
    });
    assertTrue(pending.length >= 3, 'the burst and both return checks started');
    const burst = pending[0];
    const firstReturn = pending[pending.length - 2];
    const secondReturn = pending[pending.length - 1];
    await act(async () => {
      firstReturn?.();
      secondReturn?.();
      burst?.();
    });
    assertEqual(applied.slice(-3), [false, true, false]);
    act(() => {
      renderer?.unmount();
    });
  } finally {
    browser.restore();
  }
});

it('polls every 15s only while the tab is visible and degraded', async () => {
  resetRealtimeForTests();
  const scheduled: number[] = [];
  const cleared: number[] = [];
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let nextId = 1;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    scheduled.push(Number(ms));
    void fn;
    return id as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => {
    cleared.push(id);
  }) as typeof clearInterval;

  const hidden = installBrowser('hidden');
  const degraded = createFakeClient('subscribe-throws');
  let hiddenRenderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      hiddenRenderer = await renderTree(createElement(Screen, {
        client: degraded.client,
        onRefresh: () => undefined,
      }));
    });
    assertTrue(!scheduled.includes(WEB_REALTIME_POLL_MS), 'a hidden degraded tab does not poll');
    hidden.browser.visibilityState = 'visible';
    await act(async () => {
      hidden.browser.dispatch('visibilitychange');
    });
    assertTrue(scheduled.includes(WEB_REALTIME_POLL_MS), 'showing a degraded tab starts the 15s poll');
    const started = scheduled.length;
    hidden.browser.visibilityState = 'hidden';
    await act(async () => {
      hidden.browser.dispatch('visibilitychange');
    });
    assertTrue(cleared.length > 0, 'hiding clears the poll');
    assertEqual(scheduled.length, started);
    act(() => {
      hiddenRenderer?.unmount();
    });
    resetRealtimeForTests();
    const visible = installBrowser('visible');
    const healthy = createFakeClient();
    const beforeHealthy = scheduled.length;
    let healthyRenderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        healthyRenderer = await renderTree(createElement(Screen, {
          client: healthy.client,
          onRefresh: () => undefined,
        }));
      });
      assertTrue(!scheduled.slice(beforeHealthy).includes(WEB_REALTIME_POLL_MS), 'a subscribed tab does not poll');
      act(() => {
        healthyRenderer?.unmount();
      });
    } finally {
      visible.restore();
    }
  } finally {
    hidden.restore();
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
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
    throw new Error(`${failed} web realtime test${failed === 1 ? '' : 's'} failed`);
  }
}

void run();
