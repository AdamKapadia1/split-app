import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { allocateRealtimeInstance } from '@/hooks/safeRealtimeChannel';
import { supabase } from '@/lib/supabase';
import { logger } from '@/utils/logger';

export type SyncStatus = 'disconnected' | 'connecting' | 'live' | 'error';

type ChangeRow = Record<string, unknown>;
type ChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE';
type WatchedTable = 'receipts' | 'items' | 'splits';

const CHANGE_EVENTS: readonly ChangeEvent[] = ['INSERT', 'UPDATE', 'DELETE'];

/**
 * Subscribes to receipt, item, and split changes for one receipt.
 * `onUpdate` runs at most once per 150ms burst. The socket is removed on
 * unmount, when `receiptId` changes, and when the app leaves the foreground.
 */
export function useRealtimeSync(receiptId: string | null, onUpdate: () => void) {
  const reactId = useId();
  const [instanceId] = useState(allocateRealtimeInstance);
  const [report, setReport] = useState<{ id: string; status: 'live' | 'error' } | null>(null);
  const [isActive, setIsActive] = useState(AppState.currentState === 'active');
  const channelRef = useRef<RealtimeChannel | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUpdateRef = useRef(onUpdate);

  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  const handlePayload = useCallback((table: WatchedTable, payload: RealtimePostgresChangesPayload<ChangeRow>) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    logger.debug('Realtime change', { table, event: payload.eventType });

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      onUpdateRef.current();
    }, 150);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setIsActive(nextState === 'active');
    });

    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const client = supabase;
    if (!receiptId || !client || !isActive) {
      return;
    }

    const topic = `receipt-${receiptId}:${reactId}:${instanceId}`;
    let channel: RealtimeChannel | null = null;
    let active = true;
    try {
      channel = client.channel(topic);
      channelRef.current = channel;
      watchTable(channel, 'receipts', `id=eq.${receiptId}`, handlePayload);
      watchTable(channel, 'items', `receipt_id=eq.${receiptId}`, handlePayload);
      watchTable(channel, 'splits', undefined, handlePayload);
      channel.subscribe((startStatus) => {
        if (!active) return;
        try {
          if (startStatus === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
            setReport({ id: receiptId, status: 'live' });
            logger.debug('Realtime connected');
            return;
          }

          if (startStatus === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR || startStatus === REALTIME_SUBSCRIBE_STATES.TIMED_OUT) {
            setReport({ id: receiptId, status: 'error' });
            logger.error('Realtime', { code: startStatus });
          }
        } catch (error) {
          logger.error('Realtime', { code: 'STATUS_FAILED', error });
        }
      });
    } catch (error) {
      logger.error('Realtime', { code: 'SUBSCRIBE_FAILED', error });
    }

    return () => {
      active = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }

      channelRef.current = null;
      if (!channel) return;
      try {
        channel.unsubscribe();
      } catch (error) {
        logger.error('Realtime', { code: 'UNSUBSCRIBE_FAILED', error });
      }
      try {
        void client.removeChannel(channel);
      } catch (error) {
        logger.error('Realtime', { code: 'REMOVE_CHANNEL_FAILED', error });
      }
      logger.debug('Realtime disconnected');
    };
  }, [handlePayload, instanceId, isActive, reactId, receiptId]);

  const status: SyncStatus =
    !receiptId || !supabase || !isActive
      ? 'disconnected'
      : report?.id === receiptId
        ? report.status
        : 'connecting';

  return { status };
}

function watchTable(
  channel: RealtimeChannel,
  table: WatchedTable,
  filter: string | undefined,
  handlePayload: (table: WatchedTable, payload: RealtimePostgresChangesPayload<ChangeRow>) => void,
) {
  for (const event of CHANGE_EVENTS) {
    channel.on(
      'postgres_changes',
      {
        event,
        schema: 'public',
        table,
        ...(filter ? { filter } : {}),
      },
      (payload) => {
        handlePayload(table, payload);
      },
    );
  }
}
