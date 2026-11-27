import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  listenSharedBroadcast,
  type RealtimeChannelLike,
  type RealtimeClientLike,
} from '@/hooks/safeRealtimeChannel';
import { logger } from '@/utils/logger';
import { SPLIT_SYNC_EVENT, splitSyncTopic } from '@/utils/splitSync';

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
 * Guest-web Realtime for one share token.
 * Each mount gets its own topic so Strict Mode cannot join a channel twice.
 * Browser listeners and the degraded poll exist only on web.
 */
export function useWebSplitRealtime({
  shareToken,
  receiptId = null,
  onRefresh,
  client,
}: {
  shareToken: string | null;
  receiptId?: string | null;
  onRefresh: RefreshHandler;
  client?: RealtimeClientLike | null;
}): WebRealtimeStatus {
  const [instanceId] = useState(allocateWebInstance);
  const fetchSeqRef = useRef(0);
  const onRefreshRef = useRef(onRefresh);
  const statusRef = useRef<WebRealtimeStatus>('IDLE');
  const [status, setStatus] = useState<WebRealtimeStatus>('IDLE');

  useLayoutEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    const usableToken = typeof shareToken === 'string' && TOKEN_PATTERN.test(shareToken) ? shareToken : null;
    if (!usableToken) {
      statusRef.current = 'IDLE';
      return;
    }

    let disposed = false;
    let mounted = true;
    let channel: RealtimeChannelLike | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const stops: (() => void)[] = [];
    const realtime = resolveClient(client);
    const receiptFilter = typeof receiptId === 'string' && UUID_PATTERN.test(receiptId) ? receiptId : null;

    function publishStatus(next: WebRealtimeStatus) {
      statusRef.current = next;
      if (disposed) return;
      setStatus(next);
    }

    function isCurrent(seq: number) {
      return mounted && seq === fetchSeqRef.current;
    }

    async function runRefresh(reason: WebRefreshReason) {
      const seq = fetchSeqRef.current + 1;
      fetchSeqRef.current = seq;
      try {
        await onRefreshRef.current(() => isCurrent(seq), reason);
      } catch (error) {
        logger.error('web-realtime', { code: 'REFRESH_FAILED', error });
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

    function bindChanges(next: RealtimeChannelLike) {
      const emit = () => {
        try {
          scheduleRefresh();
        } catch (error) {
          logger.error('web-realtime', { code: 'EVENT_FAILED', error });
        }
      };
      if (!receiptFilter) return;
      next.on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'receipt_share_participants',
        filter: `receipt_id=eq.${receiptFilter}`,
      }, emit);
      next.on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'receipt_share_claims',
        filter: `receipt_id=eq.${receiptFilter}`,
      }, emit);
      next.on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'receipts',
        filter: `id=eq.${receiptFilter}`,
      }, emit);
    }

    function syncPoll() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (!isWebPlatform() || disposed) return;
      if (statusRef.current !== 'DEGRADED') return;
      if (visibilityState() !== 'visible') return;
      try {
        pollTimer = setInterval(() => {
          try {
            if (disposed || statusRef.current !== 'DEGRADED' || visibilityState() !== 'visible') return;
            immediateRefresh('poll');
          } catch (error) {
            logger.error('web-realtime', { code: 'POLL_FAILED', error });
          }
        }, WEB_REALTIME_POLL_MS);
      } catch (error) {
        logger.error('web-realtime', { code: 'POLL_FAILED', error });
      }
    }

    function openChannel() {
      closeChannel();
      if (disposed) return;
      if (!realtime) {
        publishStatus('DEGRADED');
        syncPoll();
        return;
      }
      publishStatus('CONNECTING');
      try {
        const topic = `web-split:${usableToken}:${instanceId}-${randomSuffix()}`;
        const next = realtime.channel(topic);
        channel = next;
        try {
          bindChanges(next);
        } catch (error) {
          logger.error('web-realtime', { code: 'BIND_FAILED', error });
          publishStatus('DEGRADED');
        }
        try {
          next.subscribe((nextStatus) => {
            try {
              if (disposed) return;
              if (nextStatus === 'SUBSCRIBED') publishStatus('SUBSCRIBED');
              else if (nextStatus === 'CHANNEL_ERROR' || nextStatus === 'TIMED_OUT' || nextStatus === 'CLOSED') {
                publishStatus('DEGRADED');
              }
              syncPoll();
            } catch (error) {
              logger.error('web-realtime', { code: 'STATUS_FAILED', error });
              publishStatus('DEGRADED');
              syncPoll();
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
      syncPoll();
    }

    function recover() {
      immediateRefresh('visible');
      if (statusRef.current !== 'SUBSCRIBED') openChannel();
      else syncPoll();
    }

    try {
      openChannel();
      if (realtime) {
        stops.push(listenSharedBroadcast(realtime, splitSyncTopic(usableToken), SPLIT_SYNC_EVENT, () => {
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
    } catch (error) {
      logger.error('web-realtime', { code: 'EFFECT_FAILED', error });
      publishStatus('DEGRADED');
      syncPoll();
    }

    return () => {
      disposed = true;
      mounted = false;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      for (const stop of stops) {
        try {
          stop();
        } catch (error) {
          logger.error('web-realtime', { code: 'CLEANUP_FAILED', error });
        }
      }
      closeChannel();
    };
  }, [client, fetchSeqRef, instanceId, onRefreshRef, receiptId, shareToken, statusRef]);

  const usableToken = typeof shareToken === 'string' && TOKEN_PATTERN.test(shareToken);
  return usableToken ? status : 'IDLE';
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
