import { useEffect, useLayoutEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { supabase } from '@/lib/supabase';
import { SPLIT_SYNC_DEBOUNCE_MS, SPLIT_SYNC_EVENT, splitSyncTopic } from '@/utils/splitSync';

/**
 * Public invalidation channel for one share token.
 * The payload is ignored; the screen refetches through the guest RPC.
 */
export function useSplitRealtime(shareToken: string | null, onInvalidate: () => void, receiptId?: string | null) {
  const onInvalidateRef = useRef(onInvalidate);
  useLayoutEffect(() => {
    onInvalidateRef.current = onInvalidate;
  }, [onInvalidate]);

  useEffect(() => {
    if (!shareToken || !supabase) return;
    const client = supabase;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onInvalidateRef.current();
      }, SPLIT_SYNC_DEBOUNCE_MS);
    };

    const channel = client.channel(splitSyncTopic(shareToken), {
      config: { broadcast: { self: false }, private: false },
    });
    channel.on('broadcast', { event: SPLIT_SYNC_EVENT }, () => {
      schedule();
    });
    if (receiptId) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'receipts', filter: `id=eq.${receiptId}` },
        () => {
          schedule();
        },
      );
    }
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') schedule();
    });

    const onAppState = (state: string) => {
      if (state === 'active') schedule();
    };
    const appSub = AppState.addEventListener('change', onAppState);
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      schedule();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    return () => {
      if (timer) clearTimeout(timer);
      appSub.remove();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      void client.removeChannel(channel);
    };
  }, [receiptId, shareToken]);
}
