import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { logger } from '@/utils/logger';
import {
  allocateRealtimeInstance,
  bindUniqueChannel,
  createInvalidationScheduler,
  listenSharedBroadcast,
  splitInstanceTopic,
  type RealtimeClientLike,
} from '@/hooks/safeRealtimeChannel';
import { SPLIT_SYNC_DEBOUNCE_MS, SPLIT_SYNC_EVENT, splitSyncTopic } from '@/utils/splitSync';

/**
 * Public invalidation channel for one share token.
 * Postgres bindings sit on a per-instance topic so two mounted screens cannot
 * collide. Broadcasts stay on `split-sync:${token}` because the database
 * trigger addresses that exact topic, and only the first subscriber joins it.
 */
export function useSplitRealtime(
  shareToken: string | null,
  onInvalidate: () => void,
  receiptId?: string | null,
  clientOverride?: RealtimeClientLike | null,
) {
  const reactId = useId();
  const [instanceId] = useState(allocateRealtimeInstance);
  const onInvalidateRef = useRef(onInvalidate);
  useLayoutEffect(() => {
    onInvalidateRef.current = onInvalidate;
  }, [onInvalidate]);

  useEffect(() => {
    if (!shareToken) return;
    const stops: (() => void)[] = [];
    try {
      const scheduler = createInvalidationScheduler(() => onInvalidateRef.current(), SPLIT_SYNC_DEBOUNCE_MS);
      stops.push(() => scheduler.dispose());
      const client = resolveClient(clientOverride);
      const receiptFilter = typeof receiptId === 'string' && receiptId.trim() ? receiptId.trim() : '';
      stops.push(bindUniqueChannel(client, {
        topic: splitInstanceTopic(shareToken, reactId, instanceId),
        params: { config: { broadcast: { self: false }, private: false } },
        bind(channel) {
          if (!receiptFilter) return;
          channel.on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'receipts', filter: `id=eq.${receiptFilter}` },
            () => scheduler.schedule(),
          );
        },
        onStatus(status) {
          if (status === 'SUBSCRIBED') scheduler.schedule();
        },
      }));
      stops.push(listenSharedBroadcast(client, splitSyncTopic(shareToken), SPLIT_SYNC_EVENT, () => scheduler.schedule()));
      if (clientOverride === undefined) stops.push(watchAppState(() => scheduler.schedule()));
      stops.push(watchVisibility(() => scheduler.schedule()));
    } catch (error) {
      logger.error('realtime', { code: 'EFFECT_FAILED', error });
    }

    return () => {
      for (const stop of stops) {
        try {
          stop();
        } catch (error) {
          logger.error('realtime', { code: 'CLEANUP_FAILED', error });
        }
      }
    };
  }, [clientOverride, instanceId, reactId, receiptId, shareToken]);
}

function resolveClient(override: RealtimeClientLike | null | undefined): RealtimeClientLike | null {
  if (override !== undefined) return override;
  return loadSupabase();
}

function loadSupabase(): RealtimeClientLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../lib/supabase') as { supabase: RealtimeClientLike | null };
    return mod.supabase ?? null;
  } catch (error) {
    logger.error('realtime', { code: 'CLIENT_UNAVAILABLE', error });
    return null;
  }
}

function watchAppState(onActive: () => void): () => void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppState } = require('react-native') as typeof import('react-native');
    const subscription = AppState.addEventListener('change', (state) => {
      try {
        if (state === 'active') onActive();
      } catch (error) {
        logger.error('realtime', { code: 'APPSTATE_FAILED', error });
      }
    });
    return () => {
      try {
        subscription.remove();
      } catch (error) {
        logger.error('realtime', { code: 'APPSTATE_FAILED', error });
      }
    };
  } catch (error) {
    logger.error('realtime', { code: 'APPSTATE_UNAVAILABLE', error });
    return () => undefined;
  }
}

function watchVisibility(onVisible: () => void): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const onChange = () => {
    try {
      if (document.visibilityState !== 'visible') return;
      onVisible();
    } catch (error) {
      logger.error('realtime', { code: 'VISIBILITY_FAILED', error });
    }
  };
  try {
    document.addEventListener('visibilitychange', onChange);
  } catch (error) {
    logger.error('realtime', { code: 'VISIBILITY_FAILED', error });
    return () => undefined;
  }
  return () => {
    try {
      document.removeEventListener('visibilitychange', onChange);
    } catch (error) {
      logger.error('realtime', { code: 'VISIBILITY_FAILED', error });
    }
  };
}
