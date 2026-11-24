-- Read-only check for Phase 9B notification tables. Rolls back so nothing persists.
-- Run after 20261124161800_push_notifications_nudges.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/notifications_rls_verification.sql

BEGIN;

DO $$
DECLARE
  v_table text;
  v_missing text;
  v_anon text;
  v_write_grant text;
  v_write_policy text;
  v_cascade text;
  v_def text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['user_push_tokens', 'user_notification_preferences', 'settlement_nudges']
  LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'missing public.%', v_table;
    END IF;
  END LOOP;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
  INTO v_missing
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('user_push_tokens', 'user_notification_preferences', 'settlement_nudges')
    AND (c.relrowsecurity IS DISTINCT FROM true OR c.relforcerowsecurity IS DISTINCT FROM true);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY is missing on: %', v_missing;
  END IF;

  SELECT string_agg(format('%s.%s %s for %s', table_schema, table_name, privilege_type, grantee), ', ' ORDER BY table_name)
  INTO v_anon
  FROM (
    SELECT table_schema, table_name, privilege_type, grantee::text AS grantee
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND table_name IN ('user_push_tokens', 'user_notification_preferences', 'settlement_nudges')
      AND grantee IN ('anon', 'PUBLIC')
    UNION
    SELECT table_schema, table_name, privilege_type, grantee::text
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND table_name IN ('user_push_tokens', 'user_notification_preferences', 'settlement_nudges')
      AND grantee IN ('anon', 'PUBLIC')
  ) grants;

  IF v_anon IS NOT NULL THEN
    RAISE EXCEPTION 'anon or PUBLIC still has notification privileges: %', v_anon;
  END IF;

  SELECT string_agg(format('%s %s', table_name, privilege_type), ', ' ORDER BY table_name, privilege_type)
  INTO v_write_grant
  FROM information_schema.table_privileges
  WHERE table_schema = 'public'
    AND table_name = 'settlement_nudges'
    AND grantee = 'authenticated'
    AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');

  IF v_write_grant IS NOT NULL THEN
    RAISE EXCEPTION 'authenticated can write settlement_nudges: %', v_write_grant;
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.settlement_nudges', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated cannot select settlement_nudges';
  END IF;

  SELECT string_agg(format('%s %s', policyname, cmd), ', ' ORDER BY policyname)
  INTO v_write_policy
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'settlement_nudges'
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');

  IF v_write_policy IS NOT NULL THEN
    RAISE EXCEPTION 'settlement_nudges still has a client write policy: %', v_write_policy;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'settlement_nudges'
      AND cmd = 'SELECT'
      AND roles = ARRAY['authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'settlement_nudges is missing an authenticated select policy';
  END IF;

  SELECT string_agg(format('%s.%s', c.relname, con.conname), ', ' ORDER BY c.relname, con.conname)
  INTO v_cascade
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('user_push_tokens', 'user_notification_preferences', 'settlement_nudges')
    AND con.contype = 'f'
    AND con.confdeltype IS DISTINCT FROM 'c';

  IF v_cascade IS NOT NULL THEN
    RAISE EXCEPTION 'notification foreign keys are not ON DELETE CASCADE: %', v_cascade;
  END IF;

  IF (
    SELECT count(*)
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('user_push_tokens', 'user_notification_preferences', 'settlement_nudges')
      AND con.contype = 'f'
      AND con.confdeltype = 'c'
  ) < 5 THEN
    RAISE EXCEPTION 'expected cascade foreign keys on tokens, preferences, and both nudge parties plus the receipt';
  END IF;

  IF to_regprocedure('public.delete_my_account()') IS NULL THEN
    RAISE EXCEPTION 'public.delete_my_account() is missing';
  END IF;

  v_def := pg_get_functiondef('public.delete_my_account()'::regprocedure);
  IF position('DELETE FROM public.user_push_tokens' IN v_def) = 0
     OR position('DELETE FROM public.user_notification_preferences' IN v_def) = 0
     OR position('DELETE FROM public.settlement_nudges' IN v_def) = 0
  THEN
    RAISE EXCEPTION 'delete_my_account() does not explicitly erase notification data';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('user_push_tokens', 'user_notification_preferences', 'settlement_nudges')
      AND ('anon' = ANY (roles) OR 'public' = ANY (roles))
  ) THEN
    RAISE EXCEPTION 'anon or public still has a notification policy';
  END IF;

  BEGIN
    EXECUTE 'SET LOCAL ROLE authenticated';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'could not assume authenticated to test settlement_nudges';
  END;

  BEGIN
    EXECUTE $insert$
      INSERT INTO public.settlement_nudges (
        sender_id, recipient_id, receipt_id, amount_pence, idempotency_key, delivery_status
      ) VALUES (
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
        100,
        'rls-probe',
        'sent'
      )
    $insert$;
    RAISE EXCEPTION 'authenticated inserted directly into settlement_nudges';
  EXCEPTION
    WHEN insufficient_privilege THEN
      NULL;
    WHEN OTHERS THEN
      IF SQLERRM ILIKE '%authenticated inserted directly%' THEN
        RAISE;
      END IF;
      RAISE EXCEPTION 'unexpected settlement_nudges insert result: % %', SQLSTATE, SQLERRM;
  END;

  RAISE NOTICE 'notification rls verification passed';
END $$;

ROLLBACK;
