-- Phase 8 zero-trust RLS and in-app account erasure.
--
-- Gaps this migration closes, based on the migrations in this repo:
--   * public.settlements had ENABLE ROW LEVEL SECURITY but not FORCE, so the
--     table owner bypassed it. Writes were already denied (no insert/update/
--     delete policy); that deny stays in place.
--   * public.receipt_scan_rate_limits and public.receipt_scan_audit_logs had
--     ENABLE but not FORCE, and were not revoked from PUBLIC in every path.
--   * groups, group_members, receipts, items, splits, receipt_splits, and
--     profiles had no RLS in this repository. Any live policy whose expression
--     is `true`, only `auth.uid() IS NOT NULL`, or an INSERT/UPDATE missing
--     WITH CHECK is dropped at apply time and replaced with membership-scoped
--     policies below.
--   * user_payout_methods and payout_method_audit_log were already forced and
--     scoped. Those policies are kept. Audit-log writes from the client are
--     removed if a live policy ever allowed them.
--   * SECURITY DEFINER helpers that used a mutable search_path are pinned.

DO $$
DECLARE
  r record;
  v_has_anon boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') INTO v_has_anon;

  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.relname);
    IF v_has_anon THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, PUBLIC', r.relname);
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', r.relname);
    END IF;
    RAISE NOTICE 'zero-trust enforced on public.%', r.relname;
  END LOOP;
END $$;

DO $$
DECLARE
  r record;
  v_qual text;
  v_check text;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
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
      EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
      RAISE NOTICE 'dropped permissive policy %.% (%)', r.tablename, r.policyname, r.cmd;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_group_id IS NULL OR to_regclass('public.group_members') IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND gm.user_id = auth.uid()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_group_creator(p_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_created_by uuid;
BEGIN
  IF auth.uid() IS NULL OR p_group_id IS NULL OR to_regclass('public.groups') IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'groups'
      AND column_name = 'created_by'
  ) THEN
    RETURN false;
  END IF;

  EXECUTE 'SELECT created_by FROM public.groups WHERE id = $1'
    INTO v_created_by
    USING p_group_id;

  RETURN v_created_by IS NOT NULL AND v_created_by = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.can_insert_own_membership(p_group_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_group_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.is_group_creator(p_group_id) THEN
    RETURN true;
  END IF;

  IF to_regclass('public.group_members') IS NULL THEN
    RETURN false;
  END IF;

  RETURN NOT EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.can_remove_group_member(p_group_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_group_id IS NULL OR p_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF p_user_id = auth.uid() OR public.is_group_creator(p_group_id) THEN
    RETURN true;
  END IF;

  IF to_regclass('public.group_members') IS NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'group_members'
      AND column_name = 'role'
  ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND gm.user_id = auth.uid()
      AND gm.role = 'owner'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.is_receipt_host(p_receipt_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_receipt_id IS NULL OR to_regclass('public.receipts') IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.receipts r
    WHERE r.id = p_receipt_id
      AND r.host_id = auth.uid()
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.can_access_receipt(p_receipt_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_receipt_id IS NULL OR to_regclass('public.receipts') IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.receipts r
    WHERE r.id = p_receipt_id
      AND (
        r.host_id = auth.uid()
        OR r.paid_by = auth.uid()
        OR (r.group_id IS NOT NULL AND public.is_group_member(r.group_id))
        OR (
          to_regclass('public.receipt_splits') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.receipt_splits rs
            WHERE rs.receipt_id = r.id
              AND rs.user_id = auth.uid()
          )
        )
        OR (
          to_regclass('public.splits') IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.splits s
            WHERE s.receipt_id = r.id
              AND s.user_id = auth.uid()
          )
        )
      )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.shares_group_with(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS NULL OR p_user_id = auth.uid() OR to_regclass('public.group_members') IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.group_members mine
    JOIN public.group_members theirs ON theirs.group_id = mine.group_id
    WHERE mine.user_id = auth.uid()
      AND theirs.user_id = p_user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.shares_split_with(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS NULL OR p_user_id = auth.uid() THEN
    RETURN false;
  END IF;

  IF to_regclass('public.receipt_splits') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.receipt_splits mine
      JOIN public.receipt_splits theirs ON theirs.receipt_id = mine.receipt_id
      WHERE mine.user_id = auth.uid()
        AND theirs.user_id = p_user_id
    ) THEN
      RETURN true;
    END IF;

    IF to_regclass('public.receipts') IS NOT NULL AND (
      EXISTS (
        SELECT 1
        FROM public.receipts host_receipt
        JOIN public.receipt_splits peer_split ON peer_split.receipt_id = host_receipt.id
        WHERE host_receipt.host_id = auth.uid()
          AND peer_split.user_id = p_user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.receipts host_receipt
        JOIN public.receipt_splits mine ON mine.receipt_id = host_receipt.id
        WHERE host_receipt.host_id = p_user_id
          AND mine.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.receipts paid
        JOIN public.receipt_splits owe ON owe.receipt_id = paid.id
        WHERE paid.paid_by = auth.uid()
          AND owe.user_id = p_user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.receipts paid
        JOIN public.receipt_splits owe ON owe.receipt_id = paid.id
        WHERE paid.paid_by = p_user_id
          AND owe.user_id = auth.uid()
      )
    ) THEN
      RETURN true;
    END IF;
  END IF;

  IF to_regclass('public.splits') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.splits mine
    JOIN public.splits theirs ON theirs.receipt_id = mine.receipt_id
    WHERE mine.user_id = auth.uid()
      AND theirs.user_id = p_user_id
  ) THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.is_group_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_group_creator(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_insert_own_membership(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_remove_group_member(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_receipt_host(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_receipt(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shares_group_with(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.shares_split_with(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.is_group_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_group_creator(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_insert_own_membership(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_remove_group_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_receipt_host(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_receipt(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shares_group_with(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.shares_split_with(uuid) TO authenticated;

DO $$
BEGIN
  IF to_regclass('public.groups') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.groups TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS zt_groups_select ON public.groups';
    EXECUTE 'CREATE POLICY zt_groups_select ON public.groups FOR SELECT TO authenticated USING (public.is_group_member(id) OR public.is_group_creator(id))';
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'groups' AND column_name = 'created_by'
    ) THEN
      EXECUTE 'DROP POLICY IF EXISTS zt_groups_insert ON public.groups';
      EXECUTE 'CREATE POLICY zt_groups_insert ON public.groups FOR INSERT TO authenticated WITH CHECK (created_by = (SELECT auth.uid()))';
      EXECUTE 'DROP POLICY IF EXISTS zt_groups_update ON public.groups';
      EXECUTE 'CREATE POLICY zt_groups_update ON public.groups FOR UPDATE TO authenticated USING (public.is_group_creator(id)) WITH CHECK (created_by = (SELECT auth.uid()))';
      EXECUTE 'DROP POLICY IF EXISTS zt_groups_delete ON public.groups';
      EXECUTE 'CREATE POLICY zt_groups_delete ON public.groups FOR DELETE TO authenticated USING (public.is_group_creator(id))';
    END IF;
  END IF;

  IF to_regclass('public.group_members') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_members TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS zt_group_members_select ON public.group_members';
    EXECUTE 'CREATE POLICY zt_group_members_select ON public.group_members FOR SELECT TO authenticated USING (public.is_group_member(group_id) OR public.is_group_creator(group_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_group_members_insert ON public.group_members';
    EXECUTE 'CREATE POLICY zt_group_members_insert ON public.group_members FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()) AND public.can_insert_own_membership(group_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_group_members_update ON public.group_members';
    EXECUTE 'DROP POLICY IF EXISTS zt_group_members_delete ON public.group_members';
    EXECUTE 'CREATE POLICY zt_group_members_delete ON public.group_members FOR DELETE TO authenticated USING (public.can_remove_group_member(group_id, user_id))';
  END IF;

  IF to_regclass('public.receipts') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.receipts TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS zt_receipts_select ON public.receipts';
    EXECUTE 'CREATE POLICY zt_receipts_select ON public.receipts FOR SELECT TO authenticated USING (public.can_access_receipt(id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_receipts_insert ON public.receipts';
    EXECUTE 'CREATE POLICY zt_receipts_insert ON public.receipts FOR INSERT TO authenticated WITH CHECK (host_id = (SELECT auth.uid()) AND (group_id IS NULL OR public.is_group_member(group_id)))';
    EXECUTE 'DROP POLICY IF EXISTS zt_receipts_update ON public.receipts';
    EXECUTE 'CREATE POLICY zt_receipts_update ON public.receipts FOR UPDATE TO authenticated USING (host_id = (SELECT auth.uid())) WITH CHECK (host_id = (SELECT auth.uid()) AND (group_id IS NULL OR public.is_group_member(group_id)))';
    EXECUTE 'DROP POLICY IF EXISTS zt_receipts_delete ON public.receipts';
    EXECUTE 'CREATE POLICY zt_receipts_delete ON public.receipts FOR DELETE TO authenticated USING (host_id = (SELECT auth.uid()))';
  END IF;

  IF to_regclass('public.items') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.items TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS zt_items_select ON public.items';
    EXECUTE 'CREATE POLICY zt_items_select ON public.items FOR SELECT TO authenticated USING (public.can_access_receipt(receipt_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_items_insert ON public.items';
    EXECUTE 'CREATE POLICY zt_items_insert ON public.items FOR INSERT TO authenticated WITH CHECK (public.is_receipt_host(receipt_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_items_update ON public.items';
    EXECUTE 'CREATE POLICY zt_items_update ON public.items FOR UPDATE TO authenticated USING (public.is_receipt_host(receipt_id)) WITH CHECK (public.is_receipt_host(receipt_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_items_delete ON public.items';
    EXECUTE 'CREATE POLICY zt_items_delete ON public.items FOR DELETE TO authenticated USING (public.is_receipt_host(receipt_id))';
  END IF;

  IF to_regclass('public.splits') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.splits TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS zt_splits_select ON public.splits';
    EXECUTE 'CREATE POLICY zt_splits_select ON public.splits FOR SELECT TO authenticated USING (public.can_access_receipt(receipt_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_splits_insert ON public.splits';
    EXECUTE 'CREATE POLICY zt_splits_insert ON public.splits FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()) AND public.can_access_receipt(receipt_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_splits_update ON public.splits';
    EXECUTE 'CREATE POLICY zt_splits_update ON public.splits FOR UPDATE TO authenticated USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()) AND public.can_access_receipt(receipt_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_splits_delete ON public.splits';
    EXECUTE 'CREATE POLICY zt_splits_delete ON public.splits FOR DELETE TO authenticated USING (user_id = (SELECT auth.uid()) OR public.is_receipt_host(receipt_id))';
  END IF;

  IF to_regclass('public.receipt_splits') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.receipt_splits TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS zt_receipt_splits_select ON public.receipt_splits';
    EXECUTE 'CREATE POLICY zt_receipt_splits_select ON public.receipt_splits FOR SELECT TO authenticated USING (public.can_access_receipt(receipt_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_receipt_splits_insert ON public.receipt_splits';
    EXECUTE 'CREATE POLICY zt_receipt_splits_insert ON public.receipt_splits FOR INSERT TO authenticated WITH CHECK (public.is_receipt_host(receipt_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_receipt_splits_update ON public.receipt_splits';
    EXECUTE 'CREATE POLICY zt_receipt_splits_update ON public.receipt_splits FOR UPDATE TO authenticated USING (public.is_receipt_host(receipt_id)) WITH CHECK (public.is_receipt_host(receipt_id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_receipt_splits_delete ON public.receipt_splits';
    EXECUTE 'CREATE POLICY zt_receipt_splits_delete ON public.receipt_splits FOR DELETE TO authenticated USING (public.is_receipt_host(receipt_id))';
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'id'
  ) THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS zt_profiles_select ON public.profiles';
    EXECUTE 'CREATE POLICY zt_profiles_select ON public.profiles FOR SELECT TO authenticated USING (id = (SELECT auth.uid()) OR public.shares_group_with(id) OR public.shares_split_with(id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_profiles_insert ON public.profiles';
    EXECUTE 'CREATE POLICY zt_profiles_insert ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()))';
    EXECUTE 'DROP POLICY IF EXISTS zt_profiles_update ON public.profiles';
    EXECUTE 'CREATE POLICY zt_profiles_update ON public.profiles FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()))';
    EXECUTE 'DROP POLICY IF EXISTS zt_profiles_delete ON public.profiles';
    EXECUTE 'CREATE POLICY zt_profiles_delete ON public.profiles FOR DELETE TO authenticated USING (id = (SELECT auth.uid()))';
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id'
  ) THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.users TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS zt_users_select ON public.users';
    EXECUTE 'CREATE POLICY zt_users_select ON public.users FOR SELECT TO authenticated USING (id = (SELECT auth.uid()) OR public.shares_group_with(id) OR public.shares_split_with(id))';
    EXECUTE 'DROP POLICY IF EXISTS zt_users_insert ON public.users';
    EXECUTE 'CREATE POLICY zt_users_insert ON public.users FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()))';
    EXECUTE 'DROP POLICY IF EXISTS zt_users_update ON public.users';
    EXECUTE 'CREATE POLICY zt_users_update ON public.users FOR UPDATE TO authenticated USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()))';
    EXECUTE 'DROP POLICY IF EXISTS zt_users_delete ON public.users';
    EXECUTE 'CREATE POLICY zt_users_delete ON public.users FOR DELETE TO authenticated USING (id = (SELECT auth.uid()))';
  END IF;

  IF to_regclass('public.settlements') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE public.settlements FROM authenticated, anon, PUBLIC';
    EXECUTE 'GRANT SELECT ON TABLE public.settlements TO authenticated';
    EXECUTE 'DROP POLICY IF EXISTS settlements_select_group_member ON public.settlements';
    EXECUTE $policy$
      CREATE POLICY settlements_select_group_member
        ON public.settlements
        FOR SELECT
        TO authenticated
        USING (public.is_group_member(group_id))
    $policy$;
  END IF;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  IF to_regclass('public.settlements') IS NOT NULL THEN
    FOR r IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'settlements'
        AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    LOOP
      EXECUTE format('DROP POLICY %I ON public.settlements', r.policyname);
      RAISE NOTICE 'dropped settlements write policy %', r.policyname;
    END LOOP;
  END IF;

  IF to_regclass('public.payout_method_audit_log') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON TABLE public.payout_method_audit_log FROM authenticated, anon, PUBLIC';
    EXECUTE 'GRANT SELECT ON TABLE public.payout_method_audit_log TO authenticated';
    FOR r IN
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'payout_method_audit_log'
        AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    LOOP
      EXECUTE format('DROP POLICY %I ON public.payout_method_audit_log', r.policyname);
      RAISE NOTICE 'dropped payout audit write policy %', r.policyname;
    END LOOP;
  END IF;

  IF to_regclass('public.receipt_scan_rate_limits') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.receipt_scan_rate_limits FROM anon, PUBLIC, authenticated';
    FOR r IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'receipt_scan_rate_limits'
    LOOP
      EXECUTE format('DROP POLICY %I ON public.receipt_scan_rate_limits', r.policyname);
    END LOOP;
  END IF;

  IF to_regclass('public.receipt_scan_audit_logs') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.receipt_scan_audit_logs FROM anon, PUBLIC, authenticated';
    FOR r IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'receipt_scan_audit_logs'
    LOOP
      EXECUTE format('DROP POLICY %I ON public.receipt_scan_audit_logs', r.policyname);
    END LOOP;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regprocedure('public.check_and_increment_scan_quota(uuid, integer, integer)') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.check_and_increment_scan_quota(uuid, integer, integer) SET search_path = pg_catalog, public';
  END IF;
  IF to_regprocedure('public.log_payout_method_change()') IS NOT NULL THEN
    EXECUTE 'ALTER FUNCTION public.log_payout_method_change() SET search_path = pg_catalog, public';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  v_uid uuid;
  v_group uuid;
  v_other uuid;
  v_receipt record;
  v_fk record;
  v_pii text;
  v_still boolean;
  v_restore jsonb := '[]'::jsonb;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_uid::text, 0));

  IF to_regclass('public.user_payout_methods') IS NOT NULL THEN
    DELETE FROM public.user_payout_methods WHERE user_id = v_uid;
  END IF;

  IF to_regclass('public.payout_method_audit_log') IS NOT NULL THEN
    DELETE FROM public.payout_method_audit_log WHERE user_id = v_uid;
  END IF;

  IF to_regclass('public.receipt_scan_rate_limits') IS NOT NULL THEN
    DELETE FROM public.receipt_scan_rate_limits WHERE user_id = v_uid;
  END IF;

  IF to_regclass('public.receipt_scan_audit_logs') IS NOT NULL THEN
    DELETE FROM public.receipt_scan_audit_logs WHERE user_id = v_uid;
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL THEN
    SELECT pg_catalog.string_agg(pg_catalog.format('%I = NULL', column_name), ', ')
    INTO v_pii
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND is_nullable = 'YES'
      AND column_name IN ('email', 'phone', 'full_name', 'avatar_url', 'payment_link', 'display_name', 'username', 'name');

    IF v_pii IS NOT NULL AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'id'
    ) THEN
      EXECUTE 'UPDATE public.profiles SET ' || v_pii || ' WHERE id = $1' USING v_uid;
    END IF;
  END IF;

  IF to_regclass('public.users') IS NOT NULL THEN
    SELECT pg_catalog.string_agg(pg_catalog.format('%I = NULL', column_name), ', ')
    INTO v_pii
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND is_nullable = 'YES'
      AND column_name IN ('email', 'phone', 'full_name', 'avatar_url', 'payment_link', 'display_name', 'username', 'name');

    IF v_pii IS NOT NULL AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id'
    ) THEN
      EXECUTE 'UPDATE public.users SET ' || v_pii || ' WHERE id = $1' USING v_uid;
    END IF;
  END IF;

  IF to_regclass('public.groups') IS NOT NULL
     AND to_regclass('public.group_members') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'groups' AND column_name = 'created_by'
     )
  THEN
    FOR v_group IN
      SELECT g.id
      FROM public.groups g
      WHERE g.created_by = v_uid
         OR NOT EXISTS (
           SELECT 1 FROM public.group_members gm
           WHERE gm.group_id = g.id AND gm.user_id <> v_uid
         ) AND EXISTS (
           SELECT 1 FROM public.group_members gm
           WHERE gm.group_id = g.id AND gm.user_id = v_uid
         )
    LOOP
      SELECT gm.user_id
      INTO v_other
      FROM public.group_members gm
      WHERE gm.group_id = v_group
        AND gm.user_id <> v_uid
      ORDER BY gm.user_id
      LIMIT 1;

      IF v_other IS NULL THEN
        DELETE FROM public.groups WHERE id = v_group;
      ELSE
        UPDATE public.groups SET created_by = v_other WHERE id = v_group AND created_by = v_uid;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'group_members' AND column_name = 'role'
        ) THEN
          UPDATE public.group_members
          SET role = 'owner'
          WHERE group_id = v_group
            AND user_id = v_other;
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF to_regclass('public.receipts') IS NOT NULL THEN
    FOR v_receipt IN
      SELECT id, group_id
      FROM public.receipts
      WHERE host_id = v_uid
    LOOP
      v_other := NULL;

      IF v_receipt.group_id IS NOT NULL AND to_regclass('public.group_members') IS NOT NULL THEN
        SELECT gm.user_id
        INTO v_other
        FROM public.group_members gm
        WHERE gm.group_id = v_receipt.group_id
          AND gm.user_id <> v_uid
        LIMIT 1;
      END IF;

      IF v_other IS NULL AND to_regclass('public.receipt_splits') IS NOT NULL THEN
        SELECT rs.user_id
        INTO v_other
        FROM public.receipt_splits rs
        WHERE rs.receipt_id = v_receipt.id
          AND rs.user_id <> v_uid
        LIMIT 1;
      END IF;

      IF v_other IS NULL AND to_regclass('public.splits') IS NOT NULL THEN
        SELECT s.user_id
        INTO v_other
        FROM public.splits s
        WHERE s.receipt_id = v_receipt.id
          AND s.user_id <> v_uid
        LIMIT 1;
      END IF;

      IF v_other IS NULL THEN
        DELETE FROM public.receipts WHERE id = v_receipt.id;
      ELSE
        UPDATE public.receipts SET host_id = v_other WHERE id = v_receipt.id;
      END IF;
    END LOOP;
  END IF;

  IF to_regclass('public.group_members') IS NOT NULL THEN
    DELETE FROM public.group_members WHERE user_id = v_uid;
  END IF;

  FOR v_fk IN
    SELECT
      n.nspname AS schema_name,
      cl.relname AS table_name,
      a.attname AS column_name,
      c.conname AS constraint_name,
      a.attnotnull AS not_null,
      nf.nspname AS ref_schema,
      cf.relname AS ref_table,
      af.attname AS ref_column
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_class cf ON cf.oid = c.confrelid
    JOIN pg_namespace nf ON nf.oid = cf.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
    WHERE c.contype = 'f'
      AND n.nspname = 'public'
      AND cardinality(c.conkey) = 1
      AND cf.relname IN ('users', 'profiles')
      AND nf.nspname IN ('auth', 'public')
  LOOP
    IF v_fk.table_name IN ('profiles', 'users') THEN
      CONTINUE;
    END IF;

    IF v_fk.table_name IN (
      'user_payout_methods',
      'payout_method_audit_log',
      'receipt_scan_rate_limits',
      'receipt_scan_audit_logs',
      'group_members'
    ) THEN
      EXECUTE format('DELETE FROM %I.%I WHERE %I = $1', v_fk.schema_name, v_fk.table_name, v_fk.column_name)
        USING v_uid;
      CONTINUE;
    END IF;

    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE %I = $1)', v_fk.schema_name, v_fk.table_name, v_fk.column_name)
      INTO v_still
      USING v_uid;

    IF NOT v_still THEN
      CONTINUE;
    END IF;

    IF NOT v_fk.not_null THEN
      EXECUTE format(
        'UPDATE %I.%I SET %I = NULL WHERE %I = $1',
        v_fk.schema_name, v_fk.table_name, v_fk.column_name, v_fk.column_name
      ) USING v_uid;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', v_fk.schema_name, v_fk.table_name, v_fk.constraint_name);
    v_restore := v_restore || jsonb_build_array(jsonb_build_object(
      'schema_name', v_fk.schema_name,
      'table_name', v_fk.table_name,
      'column_name', v_fk.column_name,
      'constraint_name', v_fk.constraint_name,
      'ref_schema', v_fk.ref_schema,
      'ref_table', v_fk.ref_table,
      'ref_column', v_fk.ref_column
    ));
  END LOOP;

  IF to_regclass('public.profiles') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'id'
  ) THEN
    DELETE FROM public.profiles WHERE id = v_uid;
  END IF;

  IF to_regclass('public.users') IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id'
  ) THEN
    DELETE FROM public.users WHERE id = v_uid;
  END IF;

  BEGIN
    IF to_regclass('storage.objects') IS NOT NULL THEN
      DELETE FROM storage.objects WHERE owner = v_uid;
    END IF;
  EXCEPTION
    WHEN undefined_column OR insufficient_privilege THEN
      NULL;
  END;

  DELETE FROM auth.users WHERE id = v_uid;

  FOR v_fk IN
    SELECT *
    FROM jsonb_to_recordset(v_restore) AS restored(
      schema_name text,
      table_name text,
      column_name text,
      constraint_name text,
      ref_schema text,
      ref_table text,
      ref_column text
    )
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I.%I (%I) NOT VALID',
      v_fk.schema_name,
      v_fk.table_name,
      v_fk.constraint_name,
      v_fk.column_name,
      v_fk.ref_schema,
      v_fk.ref_table,
      v_fk.ref_column
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated;
