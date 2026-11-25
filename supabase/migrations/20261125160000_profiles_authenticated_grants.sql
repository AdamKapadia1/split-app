-- Least-privilege access for public.profiles.
--
-- 42501 on a signed-in profile read means `authenticated` has no table
-- privilege (REVOKE from the zero-trust migration, with the later GRANT
-- skipped when the table was created afterwards). A missing policy does not
-- raise 42501; it hides every row. This migration grants only what the app
-- uses and keeps RLS forced on. It does not grant `anon` and does not touch
-- the service role.
--
-- SELECT stays limited to the caller's own row, plus co-members when the
-- existing share helpers are installed, so group and home screens can still
-- read names of people the caller already splits with. INSERT and UPDATE
-- are own-row only.

DO $$
DECLARE
  r record;
  v_qual text;
  v_check text;
  v_has_anon boolean;
  v_select text;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE NOTICE 'public.profiles is absent; skipping profile grants';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'id'
  ) THEN
    RAISE EXCEPTION 'public.profiles.id is required for profile RLS';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') INTO v_has_anon;

  EXECUTE 'ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON TABLE public.profiles FROM PUBLIC';
  IF v_has_anon THEN
    EXECUTE 'REVOKE ALL ON TABLE public.profiles FROM anon';
  END IF;
  EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated';

  FOR r IN
    SELECT policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
  LOOP
    v_qual := regexp_replace(lower(COALESCE(r.qual, '')), '\s+', '', 'g');
    v_check := regexp_replace(lower(COALESCE(r.with_check, '')), '\s+', '', 'g');

    IF v_qual IN ('true', '(true)')
       OR v_check IN ('true', '(true)')
       OR v_qual IN ('auth.uid()isnotnull', '(auth.uid()isnotnull)')
       OR v_check IN ('auth.uid()isnotnull', '(auth.uid()isnotnull)')
       OR (r.cmd = 'INSERT' AND COALESCE(r.with_check, '') = '')
       OR (r.cmd = 'UPDATE' AND COALESCE(r.with_check, '') = '')
       OR (r.cmd = 'ALL' AND (v_qual IN ('true', '(true)') OR COALESCE(r.with_check, '') = ''))
    THEN
      EXECUTE format('DROP POLICY %I ON public.profiles', r.policyname);
    END IF;
  END LOOP;

  IF to_regprocedure('public.shares_group_with(uuid)') IS NOT NULL
     AND to_regprocedure('public.shares_split_with(uuid)') IS NOT NULL THEN
    v_select := 'id = (SELECT auth.uid()) OR public.shares_group_with(id) OR public.shares_split_with(id)';
  ELSE
    v_select := 'id = (SELECT auth.uid())';
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS zt_profiles_select ON public.profiles';
  EXECUTE format(
    'CREATE POLICY zt_profiles_select ON public.profiles FOR SELECT TO authenticated USING (%s)',
    v_select
  );
  EXECUTE 'DROP POLICY IF EXISTS zt_profiles_insert ON public.profiles';
  EXECUTE 'CREATE POLICY zt_profiles_insert ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()))';
  EXECUTE 'DROP POLICY IF EXISTS zt_profiles_update ON public.profiles';
  EXECUTE 'CREATE POLICY zt_profiles_update ON public.profiles FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()))';
END $$;
