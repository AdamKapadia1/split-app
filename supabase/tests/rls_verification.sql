-- Repeatable, read-only check that every public table forces row level security
-- and that anon retains no table privileges. Rolls back so a later edit cannot
-- persist writes from this file.
-- Run after 20261123193000_zero_trust_rls_account_deletion.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_verification.sql

BEGIN;

DO $$
DECLARE
  v_tables integer;
  v_missing text;
  v_anon text;
  v_permissive text;
  v_writes text;
  v_anon_execute boolean;
  v_auth_execute boolean;
BEGIN
  SELECT count(*)
  INTO v_tables
  FROM pg_tables t
  JOIN pg_class c ON c.relname = t.tablename
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
  WHERE t.schemaname = 'public'
    AND c.relkind IN ('r', 'p');

  IF v_tables = 0 THEN
    RAISE EXCEPTION 'rls verification found no tables in public';
  END IF;

  SELECT string_agg(t.tablename, ', ' ORDER BY t.tablename)
  INTO v_missing
  FROM pg_tables t
  JOIN pg_class c ON c.relname = t.tablename
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
  WHERE t.schemaname = 'public'
    AND c.relkind IN ('r', 'p')
    AND (c.relrowsecurity IS DISTINCT FROM true OR c.relforcerowsecurity IS DISTINCT FROM true);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'RLS is not enabled and forced on: %', v_missing;
  END IF;

  SELECT string_agg(format('%s.%s %s for %s', table_schema, table_name, privilege_type, grantee), ', ' ORDER BY table_name)
  INTO v_anon
  FROM (
    SELECT table_schema, table_name, privilege_type, grantee::text AS grantee
    FROM information_schema.table_privileges
    WHERE table_schema = 'public'
      AND grantee IN ('anon', 'PUBLIC')
    UNION
    SELECT table_schema, table_name, privilege_type, grantee::text
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND grantee IN ('anon', 'PUBLIC')
  ) grants;

  IF v_anon IS NOT NULL THEN
    RAISE EXCEPTION 'anon or PUBLIC still has privileges: %', v_anon;
  END IF;

  SELECT string_agg(format('%s.%s', tablename, policyname), ', ' ORDER BY tablename, policyname)
  INTO v_permissive
  FROM pg_policies
  WHERE schemaname = 'public'
    AND (
      regexp_replace(lower(COALESCE(qual, '')), '\s+', '', 'g') IN ('true', '(true)')
      OR regexp_replace(lower(COALESCE(with_check, '')), '\s+', '', 'g') IN ('true', '(true)')
    );

  IF v_permissive IS NOT NULL THEN
    RAISE EXCEPTION 'permissive policies remain: %', v_permissive;
  END IF;

  SELECT string_agg(format('%s.%s', tablename, policyname), ', ' ORDER BY tablename, policyname)
  INTO v_writes
  FROM pg_policies
  WHERE schemaname = 'public'
    AND cmd IN ('INSERT', 'UPDATE', 'ALL')
    AND COALESCE(with_check, '') = '';

  IF v_writes IS NOT NULL THEN
    RAISE EXCEPTION 'write policies missing WITH CHECK: %', v_writes;
  END IF;

  IF to_regprocedure('public.delete_my_account()') IS NULL THEN
    RAISE EXCEPTION 'public.delete_my_account() is missing';
  END IF;

  v_anon_execute := has_function_privilege('anon', 'public.delete_my_account()', 'EXECUTE')
    OR has_function_privilege('public', 'public.delete_my_account()', 'EXECUTE');
  v_auth_execute := has_function_privilege('authenticated', 'public.delete_my_account()', 'EXECUTE');

  IF v_anon_execute THEN
    RAISE EXCEPTION 'anon or PUBLIC can execute delete_my_account()';
  END IF;

  IF NOT v_auth_execute THEN
    RAISE EXCEPTION 'authenticated cannot execute delete_my_account()';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('receipts', 'items', 'receipt_splits')
      AND (
        'anon' = ANY (roles)
        OR 'public' = ANY (roles)
      )
  ) THEN
    RAISE EXCEPTION 'anon or public still has a receipt policy';
  END IF;

  RAISE NOTICE 'rls verification passed for % public tables', v_tables;
END $$;

ROLLBACK;
