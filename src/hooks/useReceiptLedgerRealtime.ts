import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { logger } from '@/utils/logger';
import {
  allocateRealtimeInstance,
  bindUniqueChannel,
  createInvalidationScheduler,
  receiptLedgerTopic,
  type RealtimeClientLike,
} from '@/hooks/safeRealtimeChannel';

const DEBOUNCE_MS = 200;

/**
 * Refetches group and home ledgers when a receipt row changes.
 * Each mounted screen gets its own channel topic. Realtime is optional:
 * a missing client, a dead socket, or a thrown callback leaves the screen up.
 * Focus effects still refetch when this subscription cannot.
 */
export function useReceiptLedgerRealtime(
  onInvalidate: () => void,
  groupId?: string | null,
  clientOverride?: RealtimeClientLike | null,
) {
  const reactId = useId();
  const [instanceId] = useState(allocateRealtimeInstance);
  const onInvalidateRef = useRef(onInvalidate);
  useLayoutEffect(() => {
    onInvalidateRef.current = onInvalidate;
  }, [onInvalidate]);

  useEffect(() => {
    const stops: (() => void)[] = [];
    try {
      const scheduler = createInvalidationScheduler(() => onInvalidateRef.current(), DEBOUNCE_MS);
      stops.push(() => scheduler.dispose());
      const scope = typeof groupId === 'string' && groupId.trim() ? groupId.trim() : 'visible';
      const client = resolveClient(clientOverride);
      stops.push(bindUniqueChannel(client, {
        topic: receiptLedgerTopic(scope, reactId, instanceId),
        bind(channel) {
          channel.on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'receipts',
              ...(scope === 'visible' ? {} : { filter: `group_id=eq.${scope}` }),
            },
            () => scheduler.schedule(),
          );
        },
        onStatus(status) {
          if (status === 'SUBSCRIBED') scheduler.schedule();
        },
      }));
      if (clientOverride === undefined) stops.push(watchAppState(() => scheduler.schedule()));
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
  }, [clientOverride, groupId, instanceId, reactId]);
}

function resolveClient(override: RealtimeClientLike | null | undefined): RealtimeClientLike | null {
  if (override !== undefined) return override;
  return loadSupabase();
}

function loadSupabase(): RealtimeClientLike | null {
  try {
    // Lazy require keeps a missing client from crashing the screen module.
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
