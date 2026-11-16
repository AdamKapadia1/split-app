import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';

import { supabase } from '@/lib/supabase';

export function useSupabaseSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(supabase === null);

  useEffect(() => {
    if (!supabase) {
      return;
    }

    let active = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) {
          return;
        }
        setSession(data.session);
        setReady(true);
      })
      .catch(() => {
        if (active) {
          setReady(true);
        }
      });

    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return { session, ready };
}
