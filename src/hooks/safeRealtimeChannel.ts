import { logger } from '@/utils/logger';

const DEBOUNCE_FLOOR_MS = 0;

export type RealtimeChannelLike = {
  on: (type: string, filter: Record<string, unknown>, callback: (...args: unknown[]) => void) => RealtimeChannelLike;
  subscribe: (callback?: (status: string, error?: unknown) => void) => RealtimeChannelLike;
  unsubscribe: () => unknown;
};

export type RealtimeClientLike = {
  channel: (topic: string, params?: Record<string, unknown>) => RealtimeChannelLike;
  removeChannel: (channel: RealtimeChannelLike) => unknown;
};

let nextInstance = 0;

type SharedBroadcast = {
  channel: RealtimeChannelLike | null;
  listeners: Set<() => void>;
  subscribed: boolean;
};

const sharedBroadcasts = new Map<string, SharedBroadcast>();

export function allocateRealtimeInstance(): number {
  nextInstance += 1;
  return nextInstance;
}

export function resetRealtimeForTests() {
  nextInstance = 0;
  sharedBroadcasts.clear();
}

export function receiptLedgerTopic(scope: string, reactId: string, instance: number): string {
  const safeScope = scope.trim() || 'visible';
  return `receipt-status:${safeScope}:${reactId}:${instance}`;
}

export function splitInstanceTopic(shareToken: string, reactId: string, instance: number): string {
  return `split-sync:${shareToken}:${reactId}:${instance}`;
}

/**
 * Coalesces realtime bursts and ignores anything scheduled after dispose.
 * A throwing listener is logged and swallowed.
 */
export function createInvalidationScheduler(onInvalidate: () => void, debounceMs: number) {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wait = Number.isFinite(debounceMs) ? Math.max(DEBOUNCE_FLOOR_MS, debounceMs) : DEBOUNCE_FLOOR_MS;

  return {
    schedule() {
      try {
        if (!active) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (!active) return;
          try {
            onInvalidate();
          } catch (error) {
            logger.error('realtime', { code: 'INVALIDATE_FAILED', error });
          }
        }, wait);
      } catch (error) {
        logger.error('realtime', { code: 'SCHEDULE_FAILED', error });
      }
    },
    dispose() {
      active = false;
      try {
        if (timer) clearTimeout(timer);
      } catch (error) {
        logger.error('realtime', { code: 'SCHEDULE_FAILED', error });
      }
      timer = null;
    },
  };
}

/**
 * Opens one Supabase channel under a caller-supplied unique topic.
 * Channel creation, bindings, subscribe, and teardown never rethrow.
 */
export function bindUniqueChannel(
  client: RealtimeClientLike | null | undefined,
  options: {
    topic: string;
    params?: Record<string, unknown>;
    bind?: (channel: RealtimeChannelLike) => void;
    onStatus?: (status: string) => void;
  },
): () => void {
  if (!client) return () => undefined;

  let channel: RealtimeChannelLike | null = null;
  try {
    channel = options.params ? client.channel(options.topic, options.params) : client.channel(options.topic);
    try {
      options.bind?.(channel);
    } catch (error) {
      logger.error('realtime', { code: 'BIND_FAILED', topic: options.topic, error });
    }
    try {
      channel.subscribe((status) => {
        try {
          options.onStatus?.(status);
        } catch (error) {
          logger.error('realtime', { code: 'STATUS_FAILED', error });
        }
      });
    } catch (error) {
      logger.error('realtime', { code: 'SUBSCRIBE_FAILED', topic: options.topic, error });
    }
  } catch (error) {
    logger.error('realtime', { code: 'CHANNEL_FAILED', topic: options.topic, error });
    channel = null;
  }

  return closeChannel(client, () => channel);
}

/**
 * One subscription for a server-addressed broadcast topic, shared by every
 * mounted listener. Postgres changes use `bindUniqueChannel` instead, because
 * those bindings throw if a second screen attaches them after subscribe.
 */
export function listenSharedBroadcast(
  client: RealtimeClientLike | null | undefined,
  topic: string,
  event: string,
  onEvent: () => void,
): () => void {
  const key = `${topic}\0${event}`;
  let entry = sharedBroadcasts.get(key);
  if (!entry) {
    entry = { channel: null, listeners: new Set(), subscribed: false };
    sharedBroadcasts.set(key, entry);
    const current = entry;
    if (client) {
      try {
        const channel = client.channel(topic, {
          config: { broadcast: { self: false }, private: false },
        });
        current.channel = channel;
        channel.on('broadcast', { event }, () => {
          notifyListeners(current);
        });
        channel.subscribe((status) => {
          try {
            if (status !== 'SUBSCRIBED') return;
            current.subscribed = true;
            notifyListeners(current);
          } catch (error) {
            logger.error('realtime', { code: 'BROADCAST_STATUS_FAILED', error });
          }
        });
      } catch (error) {
        logger.error('realtime', { code: 'BROADCAST_SUBSCRIBE_FAILED', topic, error });
      }
    }
  }

  entry.listeners.add(onEvent);
  if (entry.subscribed) {
    try {
      onEvent();
    } catch (error) {
      logger.error('realtime', { code: 'BROADCAST_LISTENER_FAILED', error });
    }
  }

  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const current = sharedBroadcasts.get(key);
    if (!current) return;
    current.listeners.delete(onEvent);
    if (current.listeners.size > 0) return;
    sharedBroadcasts.delete(key);
    const channel = current.channel;
    current.channel = null;
    if (!channel || !client) return;
    releaseChannel(client, channel);
  };
}

function notifyListeners(entry: SharedBroadcast) {
  for (const listener of [...entry.listeners]) {
    try {
      listener();
    } catch (error) {
      logger.error('realtime', { code: 'BROADCAST_LISTENER_FAILED', error });
    }
  }
}

function closeChannel(client: RealtimeClientLike, read: () => RealtimeChannelLike | null): () => void {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const channel = read();
    if (!channel) return;
    releaseChannel(client, channel);
  };
}

function releaseChannel(client: RealtimeClientLike, channel: RealtimeChannelLike) {
  try {
    channel.unsubscribe();
  } catch (error) {
    logger.error('realtime', { code: 'UNSUBSCRIBE_FAILED', error });
  }
  try {
    client.removeChannel(channel);
  } catch (error) {
    logger.error('realtime', { code: 'REMOVE_CHANNEL_FAILED', error });
  }
}
