import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  listenSharedBroadcast,
  type RealtimeChannelLike,
  type RealtimeClientLike,
} from '@/hooks/safeRealtimeChannel';
import { logger } from '@/utils/logger';
import { SPLIT_SYNC_EVENT, splitSyncReceiptTopic } from '@/utils/splitSync';

export const WEB_REALTIME_DEBOUNCE_MS = 150;
export const WEB_REALTIME_POLL_MS = 15_000;

export type WebRealtimeStatus = 'IDLE' | 'CONNECTING' | 'SUBSCRIBED' | 'DEGRADED';
export type WebRefreshReason = 'event' | 'visible' | 'poll';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let nextWebInstance = 0;

function allocateWebInstance(): number {
  nextWebInstance += 1;
  return nextWebInstance;
}

type RefreshHandler = (isCurrent: () => boolean, reason: WebRefreshReason) => void | Promise<void>;

/**
 * Guest-web sync for one shared bill.
 *
 * Anonymous guests cannot SELECT the share tables (RLS), so Postgres row
 * events never reach them. Sync therefore comes from three sources:
 * - the `split-sync:<receiptId>` broadcast sent by the database trigger,
 * - an immediate refetch on visibilitychange / bfcache pageshow / online,
 * - a 15s poll that runs whenever the tab is visible and the bill is not
 *   settled, even while the channel reports SUBSCRIBED.
 *
 * Topics are keyed on the receipt id, never the bearer share token. Nothing
 * subscribes until the receipt id is known from the first fetch.
 */
export function useWebSplitRealtime({
  shareToken,
  receiptId = null,
  settled = false,
  onRefresh,
  client,
}: {
  shareToken: string | null;
  receiptId?: string | null;
  /** True once every share is paid. Pauses the fallback poll. */
  settled?: boolean;
  onRefresh: RefreshHandler;
  client?: RealtimeClientLike | null;
}): WebRealtimeStatus {
  const [instanceId] = useState(allocateWebInstance);
  const fetchSeqRef = useRef(0);
  const onRefreshRef = useRef(onRefresh);
  const settledRef = useRef(settled);
  const syncPollRef = useRef<(() => void) | null>(null);
  const statusRef = useRef<WebRealtimeStatus>('IDLE');
  const [status, setStatus] = useState<WebRealtimeStatus>('IDLE');

  useLayoutEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useLayoutEffect(() => {
    settledRef.current = settled;
    syncPollRef.current?.();
  }, [settled]);

  const usableToken = typeof shareToken === 'string' && TOKEN_PATTERN.test(shareToken);
  const receiptKey = typeof receiptId === 'string' && UUID_PATTERN.test(receiptId) ? receiptId.toLowerCase() : null;
  const active = usableToken && receiptKey !== null;

  useEffect(() => {
    if (!active || !receiptKey) {
      statusRef.current = 'IDLE';
      return;
    }

    let disposed = false;
    let inFlight = 0;
    let channel: RealtimeChannelLike | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const stops: (() => void)[] = [];
    const realtime = resolveClient(client);

    function publishStatus(next: WebRealtimeStatus) {
      statusRef.current = next;
      if (disposed) return;
      setStatus(next);
    }

    function isCurrent(seq: number) {
      return !disposed && seq === fetchSeqRef.current;
    }

    async function runRefresh(reason: WebRefreshReason) {
      if (disposed) return;
      const seq = fetchSeqRef.current + 1;
      fetchSeqRef.current = seq;
      inFlight += 1;
      try {
        await onRefreshRef.current(() => isCurrent(seq), reason);
      } catch (error) {
        logger.error('web-realtime', { code: 'REFRESH_FAILED', error });
      } finally {
        inFlight = Math.max(0, inFlight - 1);
      }
    }

    function scheduleRefresh() {
      try {
        if (disposed) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          if (disposed) return;
          void runRefresh('event');
        }, WEB_REALTIME_DEBOUNCE_MS);
      } catch (error) {
        logger.error('web-realtime', { code: 'SCHEDULE_FAILED', error });
      }
    }

    function immediateRefresh(reason: WebRefreshReason) {
      try {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        void runRefresh(reason);
      } catch (error) {
        logger.error('web-realtime', { code: 'REFRESH_FAILED', error });
      }
    }

    function stopPoll() {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
    }

    function shouldPoll() {
      return !disposed && isWebPlatform() && !settledRef.current && visibilityState() === 'visible';
    }

    /** Starts the poll when it should run and stops it when it should not. */
    function syncPoll() {
      try {
        if (!shouldPoll()) {
          stopPoll();
          return;
        }
        if (pollTimer) return;
        pollTimer = setInterval(() => {
          try {
            if (!shouldPoll()) {
              stopPoll();
              return;
            }
            // A slow network must not stack refetches on top of each other.
            if (inFlight > 0) return;
            void runRefresh('poll');
          } catch (error) {
            logger.error('web-realtime', { code: 'POLL_FAILED', error });
          }
        }, WEB_REALTIME_POLL_MS);
      } catch (error) {
        logger.error('web-realtime', { code: 'POLL_FAILED', error });
      }
    }

    function closeChannel() {
      const current = channel;
      channel = null;
      if (!current) return;
      try {
        current.unsubscribe();
      } catch (error) {
        logger.error('web-realtime', { code: 'UNSUBSCRIBE_FAILED', error });
      }
      if (!realtime) return;
      try {
        realtime.removeChannel(current);
      } catch (error) {
        logger.error('web-realtime', { code: 'REMOVE_CHANNEL_FAILED', error });
      }
    }

    /**
     * Per-mount connection probe. It carries no row bindings; its status tells
     * us when the socket dropped so a wake-up can reconnect.
     */
    function openChannel() {
      closeChannel();
      if (disposed) return;
      if (!realtime) {
        publishStatus('DEGRADED');
        return;
      }
      publishStatus('CONNECTING');
      try {
        const next = realtime.channel(`web-split:${receiptKey}:${instanceId}-${randomSuffix()}`);
        channel = next;
        try {
          next.subscribe((nextStatus) => {
            try {
              if (disposed) return;
              if (nextStatus === 'SUBSCRIBED') publishStatus('SUBSCRIBED');
              else if (nextStatus === 'CHANNEL_ERROR' || nextStatus === 'TIMED_OUT' || nextStatus === 'CLOSED') {
                publishStatus('DEGRADED');
              }
            } catch (error) {
              logger.error('web-realtime', { code: 'STATUS_FAILED', error });
              publishStatus('DEGRADED');
            }
          });
        } catch (error) {
          logger.error('web-realtime', { code: 'SUBSCRIBE_FAILED', error });
          publishStatus('DEGRADED');
        }
      } catch (error) {
        logger.error('web-realtime', { code: 'CHANNEL_FAILED', error });
        channel = null;
        publishStatus('DEGRADED');
      }
    }

    function recover() {
      immediateRefresh('visible');
      if (statusRef.current !== 'SUBSCRIBED') openChannel();
      syncPoll();
    }

    syncPollRef.current = syncPoll;

    try {
      openChannel();
      const topic = splitSyncReceiptTopic(receiptKey);
      if (realtime && topic) {
        stops.push(listenSharedBroadcast(realtime, topic, SPLIT_SYNC_EVENT, () => {
          try {
            scheduleRefresh();
          } catch (error) {
            logger.error('web-realtime', { code: 'EVENT_FAILED', error });
          }
        }));
      }
      if (isWebPlatform()) {
        stops.push(addListener(typeof document !== 'undefined' ? document : null, 'visibilitychange', () => {
          try {
            if (visibilityState() !== 'visible') {
              syncPoll();
              return;
            }
            recover();
          } catch (error) {
            logger.error('web-realtime', { code: 'VISIBILITY_FAILED', error });
          }
        }));
        stops.push(addListener(typeof window !== 'undefined' ? window : null, 'pageshow', (event) => {
          try {
            if (event.persisted !== true) return;
            recover();
          } catch (error) {
            logger.error('web-realtime', { code: 'PAGESHOW_FAILED', error });
          }
        }));
        stops.push(addListener(typeof window !== 'undefined' ? window : null, 'online', () => {
          try {
            recover();
          } catch (error) {
            logger.error('web-realtime', { code: 'ONLINE_FAILED', error });
          }
        }));
      }
      syncPoll();
    } catch (error) {
      logger.error('web-realtime', { code: 'EFFECT_FAILED', error });
      publishStatus('DEGRADED');
      syncPoll();
    }

    return () => {
      disposed = true;
      if (syncPollRef.current === syncPoll) syncPollRef.current = null;
      if (debounceTimer) clearTimeout(debounceTimer);
      stopPoll();
      for (const stop of stops) {
        try {
          stop();
        } catch (error) {
          logger.error('web-realtime', { code: 'CLEANUP_FAILED', error });
        }
      }
      closeChannel();
    };
  }, [active, client, instanceId, receiptKey]);

  return active ? status : 'IDLE';
}

function resolveClient(override: RealtimeClientLike | null | undefined): RealtimeClientLike | null {
  if (override !== undefined) return override;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../lib/supabase') as { supabase: RealtimeClientLike | null };
    return mod.supabase ?? null;
  } catch (error) {
    logger.error('web-realtime', { code: 'CLIENT_UNAVAILABLE', error });
    return null;
  }
}

function randomSuffix(): string {
  try {
    const cryptoRef = globalThis.crypto;
    if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
      return cryptoRef.randomUUID().replace(/-/g, '').slice(0, 12);
    }
  } catch {
    // Private browsing can hide crypto. The Math fallback still differs per mount.
  }
  return Math.random().toString(36).slice(2, 14);
}

function visibilityState(): string {
  if (typeof document === 'undefined') return 'hidden';
  try {
    return document.visibilityState || 'hidden';
  } catch {
    return 'hidden';
  }
}

function isWebPlatform(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('react-native') as { Platform?: { OS?: string } };
    return loaded.Platform?.OS === 'web';
  } catch {
    // Node tests cannot parse the React Native entrypoint. A real document
    // and window still mean this is the browser path under test.
    return true;
  }
}

function addListener(
  target: object | null,
  type: string,
  handler: (event: { persisted?: boolean }) => void,
): () => void {
  if (!target) return () => undefined;
  const record = target as {
    addEventListener?: (name: string, listener: (event: { persisted?: boolean }) => void) => void;
    removeEventListener?: (name: string, listener: (event: { persisted?: boolean }) => void) => void;
  };
  if (typeof record.addEventListener !== 'function' || typeof record.removeEventListener !== 'function') {
    return () => undefined;
  }
  try {
    record.addEventListener(type, handler);
  } catch (error) {
    logger.error('web-realtime', { code: 'LISTENER_FAILED', error });
    return () => undefined;
  }
  return () => {
    try {
      record.removeEventListener?.(type, handler);
    } catch (error) {
      logger.error('web-realtime', { code: 'LISTENER_FAILED', error });
    }
  };
}
