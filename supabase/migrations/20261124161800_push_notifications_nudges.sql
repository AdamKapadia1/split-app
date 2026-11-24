-- Phase 9B settlement nudges.
-- UK GDPR / PECR: push tokens and notification choices are personal data and are
-- erased with the account. FCA Consumer Duty: reminders are service messages about
-- an existing shared bill, the recipient can opt out, and lock-screen copy can hide
-- the amount. The nudge ledger is append-only from the client: authenticated users
-- can read their own rows and cannot insert, update, or delete them.

CREATE TABLE IF NOT EXISTS public.user_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL CHECK (expo_push_token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'),
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  device_id text NULL CHECK (device_id IS NULL OR char_length(device_id) <= 128),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_push_tokens_user_token_unique UNIQUE (user_id, expo_push_token)
);

CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_id
  ON public.user_push_tokens (user_id);

ALTER TABLE public.user_push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_push_tokens FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_push_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_push_tokens TO authenticated;

DROP POLICY IF EXISTS user_push_tokens_select ON public.user_push_tokens;
CREATE POLICY user_push_tokens_select
  ON public.user_push_tokens
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS user_push_tokens_insert ON public.user_push_tokens;
CREATE POLICY user_push_tokens_insert
  ON public.user_push_tokens
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS user_push_tokens_update ON public.user_push_tokens;
CREATE POLICY user_push_tokens_update
  ON public.user_push_tokens
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS user_push_tokens_delete ON public.user_push_tokens;
CREATE POLICY user_push_tokens_delete
  ON public.user_push_tokens
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE TABLE IF NOT EXISTS public.user_notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  settlement_nudges_enabled boolean NOT NULL DEFAULT true,
  hide_amounts_in_notifications boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notification_preferences FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_notification_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_notification_preferences TO authenticated;

DROP POLICY IF EXISTS user_notification_preferences_select ON public.user_notification_preferences;
CREATE POLICY user_notification_preferences_select
  ON public.user_notification_preferences
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS user_notification_preferences_insert ON public.user_notification_preferences;
CREATE POLICY user_notification_preferences_insert
  ON public.user_notification_preferences
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS user_notification_preferences_update ON public.user_notification_preferences;
CREATE POLICY user_notification_preferences_update
  ON public.user_notification_preferences
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.set_notification_preferences_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS user_notification_preferences_updated_at ON public.user_notification_preferences;
CREATE TRIGGER user_notification_preferences_updated_at
  BEFORE UPDATE ON public.user_notification_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.set_notification_preferences_updated_at();

REVOKE ALL ON FUNCTION public.set_notification_preferences_updated_at() FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.settlement_nudges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receipt_id uuid NOT NULL REFERENCES public.receipts(id) ON DELETE CASCADE,
  amount_pence integer NOT NULL CHECK (amount_pence > 0),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  delivery_status text NOT NULL CHECK (delivery_status IN ('sent', 'no_tokens', 'opted_out', 'failed')),
  delivered_count integer NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_nudges_distinct_parties CHECK (sender_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_settlement_nudges_cooldown
  ON public.settlement_nudges (sender_id, recipient_id, receipt_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_settlement_nudges_sender_created
  ON public.settlement_nudges (sender_id, created_at DESC);

ALTER TABLE public.settlement_nudges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_nudges FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.settlement_nudges FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.settlement_nudges TO authenticated;

DROP POLICY IF EXISTS settlement_nudges_select ON public.settlement_nudges;
CREATE POLICY settlement_nudges_select
  ON public.settlement_nudges
  FOR SELECT
  TO authenticated
  USING (sender_id = (SELECT auth.uid()) OR recipient_id = (SELECT auth.uid()));

-- No INSERT, UPDATE, or DELETE policy. service_role bypasses RLS and is the only writer.

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

  -- Push tokens, notification preferences, and nudge history are personal data.
  -- Delete them before the generic foreign-key pass, which would otherwise drop
  -- NOT NULL constraints and could leave rows behind after auth.users is removed.
  -- ON DELETE CASCADE on these tables is the backstop for any other deletion path.
  IF to_regclass('public.user_push_tokens') IS NOT NULL THEN
    DELETE FROM public.user_push_tokens WHERE user_id = v_uid;
  END IF;

  IF to_regclass('public.user_notification_preferences') IS NOT NULL THEN
    DELETE FROM public.user_notification_preferences WHERE user_id = v_uid;
  END IF;

  IF to_regclass('public.settlement_nudges') IS NOT NULL THEN
    DELETE FROM public.settlement_nudges
    WHERE sender_id = v_uid OR recipient_id = v_uid;
  END IF;

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
      'group_members',
      'user_push_tokens',
      'user_notification_preferences',
      'settlement_nudges'
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
