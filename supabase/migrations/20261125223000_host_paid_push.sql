-- Host payment alerts.
--
-- receipt_share_participants.is_paid is the paid flag (boolean).
-- amount_owed_pence is integer minor units. receipts.host_id is the host.
-- The bill screen is /receipt/[id]. push_notification_logs is service-role only.
-- claim_push_token reassigns a device token to the signed-in user. A client
-- UPDATE cannot do that: RLS only exposes rows the caller already owns, and the
-- primary key is the token.

CREATE TABLE IF NOT EXISTS public.push_tokens (
  token text PRIMARY KEY CHECK (
    char_length(token) BETWEEN 20 AND 255
    AND token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'
  ),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version text NULL CHECK (app_version IS NULL OR char_length(app_version) BETWEEN 1 AND 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_tokens_user_id_idx
  ON public.push_tokens (user_id);

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_tokens FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.push_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.push_tokens TO authenticated;

DROP POLICY IF EXISTS push_tokens_select ON public.push_tokens;
CREATE POLICY push_tokens_select
  ON public.push_tokens
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS push_tokens_insert ON public.push_tokens;
CREATE POLICY push_tokens_insert
  ON public.push_tokens
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS push_tokens_update ON public.push_tokens;
CREATE POLICY push_tokens_update
  ON public.push_tokens
  FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS push_tokens_delete ON public.push_tokens;
CREATE POLICY push_tokens_delete
  ON public.push_tokens
  FOR DELETE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE OR REPLACE FUNCTION public.touch_push_token_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = pg_catalog.now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS push_tokens_updated_at ON public.push_tokens;
CREATE TRIGGER push_tokens_updated_at
  BEFORE UPDATE ON public.push_tokens
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_push_token_updated_at();

REVOKE ALL ON FUNCTION public.touch_push_token_updated_at() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.claim_push_token(
  p_token text,
  p_platform text,
  p_app_version text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;
  IF p_token IS NULL
     OR char_length(p_token) > 255
     OR p_token !~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$' THEN
    RAISE EXCEPTION 'invalid push token' USING ERRCODE = '22023';
  END IF;
  IF p_platform IS NULL OR p_platform NOT IN ('ios', 'android') THEN
    RAISE EXCEPTION 'invalid platform' USING ERRCODE = '22023';
  END IF;
  IF p_app_version IS NOT NULL AND char_length(btrim(p_app_version)) > 32 THEN
    RAISE EXCEPTION 'invalid app version' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.push_tokens (token, user_id, platform, app_version, updated_at)
  VALUES (p_token, v_uid, p_platform, NULLIF(btrim(p_app_version), ''), pg_catalog.now())
  ON CONFLICT (token) DO UPDATE
  SET user_id = EXCLUDED.user_id,
      platform = EXCLUDED.platform,
      app_version = EXCLUDED.app_version,
      updated_at = pg_catalog.now();
END;
$$;

REVOKE ALL ON FUNCTION public.claim_push_token(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_push_token(text, text, text) TO authenticated;

CREATE TABLE IF NOT EXISTS public.push_notification_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 160
    AND idempotency_key ~ '^share_paid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(:[0-9a-f]{16})?$'
  ),
  event_type text NOT NULL CHECK (event_type IN ('share_paid')),
  bill_id uuid NULL,
  share_id uuid NULL,
  recipient_user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  push_token text NULL CHECK (
    push_token IS NULL
    OR (
      char_length(push_token) BETWEEN 20 AND 255
      AND push_token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$'
    )
  ),
  expo_ticket_id text NULL CHECK (expo_ticket_id IS NULL OR char_length(expo_ticket_id) <= 128),
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'receipt_ok', 'device_not_registered', 'expired')),
  error_code text NULL CHECK (error_code IS NULL OR char_length(error_code) <= 80),
  error_message text NULL CHECK (error_message IS NULL OR char_length(error_message) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  receipt_checked_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS push_notification_logs_status_created_idx
  ON public.push_notification_logs (status, created_at);

CREATE INDEX IF NOT EXISTS push_notification_logs_recipient_created_idx
  ON public.push_notification_logs (recipient_user_id, created_at DESC);

ALTER TABLE public.push_notification_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_notification_logs FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.push_notification_logs FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.push_tokens TO service_role;
    GRANT ALL ON TABLE public.push_notification_logs TO service_role;
  END IF;
END;
$$;

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

  IF to_regclass('public.push_tokens') IS NOT NULL THEN
    DELETE FROM public.push_tokens WHERE user_id = v_uid;
  END IF;

  IF to_regclass('public.push_notification_logs') IS NOT NULL THEN
    DELETE FROM public.push_notification_logs WHERE recipient_user_id = v_uid;
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
      'settlement_nudges',
      'push_tokens',
      'push_notification_logs'
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
