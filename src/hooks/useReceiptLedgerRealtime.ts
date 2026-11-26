import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { supabase } from '@/lib/supabase';

const DEBOUNCE_MS = 200;

/**
 * Refetches group and home ledgers when a receipt row changes.
 * Authenticated viewers only receive rows their RLS policy already allows.
 */
export function useReceiptLedgerRealtime(onInvalidate: () => void, groupId?: string | null) {
  const onInvalidateRef = useRef(onInvalidate);
  onInvalidateRef.current = onInvalidate;

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onInvalidateRef.current();
      }, DEBOUNCE_MS);
    };

    const topic = groupId ? `receipt-status:${groupId}` : 'receipt-status:visible';
    const channel = client.channel(topic);
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'receipts',
        ...(groupId ? { filter: `group_id=eq.${groupId}` } : {}),
      },
      () => {
        schedule();
      },
    );
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') schedule();
    });

    const appSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') schedule();
    });

    return () => {
      if (timer) clearTimeout(timer);
      appSub.remove();
      void client.removeChannel(channel);
    };
  }, [groupId]);
}
