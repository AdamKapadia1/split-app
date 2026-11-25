-- Share-link identity and settlement hardening.
--
-- Guests still have no table privileges. Reads and claim updates stay on the
-- token-gated SECURITY DEFINER RPCs. This migration only replaces those
-- functions: profile names, no auth UIDs in the payload, and exact pence
-- written back onto receipt_splits. FORCE ROW LEVEL SECURITY is unchanged.

CREATE OR REPLACE FUNCTION public.share_name_is_human(p_raw text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_raw IS NOT NULL
    AND char_length(p_raw) BETWEEN 1 AND 40
    AND position('@' in p_raw) = 0
    AND p_raw !~ '[[:cntrl:]]'
    AND p_raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND p_raw !~ '^[A-Za-z]{1,8}[0-9]{2,8}$';
$$;

-- Prefer a real profile name. first_name wins, then full_name.
-- Generated labels such as "Dbd512" are skipped when a human name exists,
-- and they are never returned on their own.
CREATE OR REPLACE FUNCTION public.share_person_name(p_user_id uuid, p_fallback text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first text;
  v_full text;
  v_choice text;
  v_fallback text;
BEGIN
  v_fallback := public.sanitize_share_name(p_fallback);
  IF NOT public.share_name_is_human(v_fallback) THEN
    v_fallback := NULL;
  END IF;

  IF p_user_id IS NULL OR to_regclass('public.profiles') IS NULL THEN
    RETURN COALESCE(v_fallback, 'Member');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'first_name'
  ) THEN
    EXECUTE 'SELECT NULLIF(btrim(first_name), '''') FROM public.profiles WHERE id = $1'
      INTO v_first
      USING p_user_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'full_name'
  ) THEN
    EXECUTE 'SELECT NULLIF(btrim(full_name), '''') FROM public.profiles WHERE id = $1'
      INTO v_full
      USING p_user_id;
  END IF;

  IF public.share_name_is_human(public.sanitize_share_name(v_first)) THEN
    v_choice := public.sanitize_share_name(v_first);
  ELSIF public.share_name_is_human(public.sanitize_share_name(v_full)) THEN
    v_choice := public.sanitize_share_name(v_full);
  ELSE
    v_choice := NULL;
  END IF;

  RETURN COALESCE(v_choice, v_fallback, 'Member');
END;
$$;

CREATE OR REPLACE FUNCTION public.refresh_share_participant_names(p_receipt_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.receipt_share_participants p
  SET display_name = public.share_person_name(p.user_id, p.display_name)
  WHERE p.receipt_id = p_receipt_id
    AND p.user_id IS NOT NULL
    AND p.is_guest = false
    AND p.display_name IS DISTINCT FROM public.share_person_name(p.user_id, p.display_name);
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_share_participants(p_receipt_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_host uuid;
  v_group uuid;
  v_member uuid;
BEGIN
  SELECT host_id, group_id
  INTO v_host, v_group
  FROM public.receipts
  WHERE id = p_receipt_id;

  IF v_host IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.receipt_share_participants (receipt_id, user_id, display_name, is_guest)
  VALUES (p_receipt_id, v_host, public.share_person_name(v_host, 'Host'), false)
  ON CONFLICT (receipt_id, user_id) WHERE user_id IS NOT NULL DO NOTHING;

  IF v_group IS NOT NULL AND to_regclass('public.group_members') IS NOT NULL THEN
    FOR v_member IN
      SELECT gm.user_id
      FROM public.group_members gm
      WHERE gm.group_id = v_group
    LOOP
      INSERT INTO public.receipt_share_participants (receipt_id, user_id, display_name, is_guest)
      VALUES (p_receipt_id, v_member, public.share_person_name(v_member, 'Member'), false)
      ON CONFLICT (receipt_id, user_id) WHERE user_id IS NOT NULL DO NOTHING;
    END LOOP;
  END IF;

  PERFORM public.refresh_share_participant_names(p_receipt_id);
END;
$$;

-- Members' owed pence are mirrored onto receipt_splits. A zero share deletes
-- the row. When a pounds column exists, it is the exact pence divided by 100.
CREATE OR REPLACE FUNCTION public.sync_shared_receipt_splits(p_receipt_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item_udt text;
BEGIN
  IF to_regclass('public.receipt_splits') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'receipt_splits'
      AND column_name = 'amount_minor'
  ) THEN
    RETURN;
  END IF;

  SELECT c.udt_name
  INTO v_item_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'receipt_splits'
    AND c.column_name = 'item_ids';

  DELETE FROM public.receipt_splits rs
  WHERE rs.receipt_id = p_receipt_id
    AND rs.user_id IN (
      SELECT p.user_id
      FROM public.receipt_share_participants p
      WHERE p.receipt_id = p_receipt_id
        AND p.user_id IS NOT NULL
    );

  IF v_item_udt = '_uuid' THEN
    INSERT INTO public.receipt_splits (receipt_id, user_id, amount_minor, item_ids, updated_at)
    SELECT
      p.receipt_id,
      p.user_id,
      p.amount_owed_pence,
      COALESCE((
        SELECT array_agg(c.item_id ORDER BY c.item_id)
        FROM public.receipt_share_claims c
        WHERE c.participant_id = p.id
      ), ARRAY[]::uuid[]),
      now()
    FROM public.receipt_share_participants p
    WHERE p.receipt_id = p_receipt_id
      AND p.user_id IS NOT NULL
      AND p.amount_owed_pence > 0;
  ELSIF v_item_udt = '_text' THEN
    INSERT INTO public.receipt_splits (receipt_id, user_id, amount_minor, item_ids, updated_at)
    SELECT
      p.receipt_id,
      p.user_id,
      p.amount_owed_pence,
      COALESCE((
        SELECT array_agg(c.item_id::text ORDER BY c.item_id)
        FROM public.receipt_share_claims c
        WHERE c.participant_id = p.id
      ), ARRAY[]::text[]),
      now()
    FROM public.receipt_share_participants p
    WHERE p.receipt_id = p_receipt_id
      AND p.user_id IS NOT NULL
      AND p.amount_owed_pence > 0;
  ELSIF v_item_udt = 'jsonb' THEN
    INSERT INTO public.receipt_splits (receipt_id, user_id, amount_minor, item_ids, updated_at)
    SELECT
      p.receipt_id,
      p.user_id,
      p.amount_owed_pence,
      COALESCE((
        SELECT jsonb_agg(c.item_id ORDER BY c.item_id)
        FROM public.receipt_share_claims c
        WHERE c.participant_id = p.id
      ), '[]'::jsonb),
      now()
    FROM public.receipt_share_participants p
    WHERE p.receipt_id = p_receipt_id
      AND p.user_id IS NOT NULL
      AND p.amount_owed_pence > 0;
  ELSE
    INSERT INTO public.receipt_splits (receipt_id, user_id, amount_minor, updated_at)
    SELECT p.receipt_id, p.user_id, p.amount_owed_pence, now()
    FROM public.receipt_share_participants p
    WHERE p.receipt_id = p_receipt_id
      AND p.user_id IS NOT NULL
      AND p.amount_owed_pence > 0;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'receipt_splits'
      AND column_name = 'amount'
      AND data_type IN ('numeric', 'decimal')
  ) THEN
    EXECUTE
      'UPDATE public.receipt_splits
       SET amount = round(amount_minor / 100.0, 2)
       WHERE receipt_id = $1'
    USING p_receipt_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_shared_bill(p_share_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_host uuid;
  v_items_pence bigint;
  v_service_pence bigint;
  v_tip_pence bigint;
  v_total_pence bigint;
  v_payout jsonb;
  v_link text;
  v_owner_name text;
  v_payload jsonb;
BEGIN
  IF NOT public.share_token_is_usable(p_share_token) THEN
    RAISE EXCEPTION 'invalid share token' USING ERRCODE = '22023';
  END IF;

  -- Read path does not take a row lock. Claim updates lock the receipt.
  SELECT r.id, r.host_id
  INTO v_id, v_host
  FROM public.receipts r
  WHERE r.share_token = p_share_token
    AND r.share_enabled = true;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM public.seed_share_participants(v_id);

  SELECT
    COALESCE(SUM(GREATEST(round(COALESCE(i.price, 0) * 100)::bigint, 0) * GREATEST(COALESCE(i.quantity, 1), 1)::bigint), 0),
    GREATEST(round(COALESCE(r.service_charge, 0) * 100)::bigint, 0),
    GREATEST(round(COALESCE(r.tip_amount, 0) * 100)::bigint, 0),
    GREATEST(round(COALESCE(r.total_amount, 0) * 100)::bigint, 0)
  INTO v_items_pence, v_service_pence, v_tip_pence, v_total_pence
  FROM public.receipts r
  LEFT JOIN public.items i ON i.receipt_id = r.id
  WHERE r.id = v_id
  GROUP BY r.id;

  v_owner_name := public.share_person_name(v_host, 'Host');
  v_payout := NULL;

  IF to_regclass('public.user_payout_methods') IS NOT NULL THEN
    SELECT jsonb_build_object(
      'preferred_method', m.preferred_method,
      'monzo_handle', m.monzo_handle,
      'revolut_handle', m.revolut_handle,
      'paypal_handle', m.paypal_handle,
      'bank_account_name', m.bank_account_name,
      'bank_sort_code', m.bank_sort_code,
      'bank_account_number', m.bank_account_number
    )
    INTO v_payout
    FROM public.user_payout_methods m
    WHERE m.user_id = v_host;
  END IF;

  IF to_regclass('public.profiles') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'payment_link'
  ) THEN
    EXECUTE 'SELECT payment_link FROM public.profiles WHERE id = $1'
      INTO v_link
      USING v_host;
    IF v_link ~ '^https://(monzo|revolut|paypal)\.me/[A-Za-z0-9._-]{2,64}/?$' THEN
      v_payout := COALESCE(v_payout, '{}'::jsonb) || jsonb_build_object('payment_link', v_link);
    END IF;
  END IF;

  SELECT jsonb_build_object(
    'bill', jsonb_build_object(
      'id', r.id,
      'merchant_name', COALESCE(NULLIF(btrim(r.merchant_name), ''), NULLIF(btrim(r.restaurant_name), ''), 'Receipt'),
      'bill_date', r.created_at,
      'currency', COALESCE(NULLIF(btrim(r.currency_code), ''), 'GBP'),
      'subtotal_pence', GREATEST(round(COALESCE(r.subtotal, 0) * 100)::bigint, 0),
      'vat_amount', COALESCE(r.tax_amount, 0),
      'vat_pence', GREATEST(round(COALESCE(r.tax_amount, 0) * 100)::bigint, 0),
      'service_charge_amount', COALESCE(r.service_charge, 0),
      'service_charge_pence', v_service_pence,
      'service_charge_rate', CASE
        WHEN COALESCE(r.subtotal, 0) > 0 THEN round(COALESCE(r.service_charge, 0) / r.subtotal, 4)
        ELSE NULL
      END,
      'tip_amount', COALESCE(r.tip_amount, 0),
      'tip_pence', v_tip_pence,
      'total_amount', COALESCE(r.total_amount, 0),
      'total_pence', v_total_pence,
      'is_reconciled', (
        abs(v_items_pence - v_total_pence) <= 1
        OR abs(v_items_pence + v_service_pence + v_tip_pence - v_total_pence) <= 1
      ),
      'created_at', r.created_at
    ),
    'owner', jsonb_build_object(
      'display_name', v_owner_name,
      'payout_details', v_payout
    ),
    'items', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', i.id,
          'name', COALESCE(NULLIF(btrim(i.display_name), ''), i.original_name),
          'quantity', GREATEST(COALESCE(i.quantity, 1), 1),
          'unit_price', COALESCE(i.price, 0),
          'unit_price_pence', GREATEST(round(COALESCE(i.price, 0) * 100)::bigint, 0),
          'total_price', round(COALESCE(i.price, 0) * GREATEST(COALESCE(i.quantity, 1), 1), 2),
          'total_price_pence', GREATEST(round(COALESCE(i.price, 0) * 100)::bigint, 0) * GREATEST(COALESCE(i.quantity, 1), 1),
          'claimed_by', COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', p.id,
                'display_name', p.display_name
              )
              ORDER BY p.id
            )
            FROM public.receipt_share_claims c
            JOIN public.receipt_share_participants p ON p.id = c.participant_id
            WHERE c.item_id = i.id
          ), '[]'::jsonb)
        )
        ORDER BY i.line_index NULLS LAST, i.id
      )
      FROM public.items i
      WHERE i.receipt_id = r.id
    ), '[]'::jsonb),
    'participants', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', p.id,
          'display_name', p.display_name,
          'amount_owed', to_char(p.amount_owed_pence / 100.0, 'FM999999990.00'),
          'amount_owed_pence', p.amount_owed_pence,
          'items_subtotal_pence', p.items_subtotal_pence,
          'service_charge_pence', p.service_charge_pence,
          'is_paid', p.is_paid,
          'paid_at', p.paid_at,
          'is_guest', p.is_guest
        )
        ORDER BY p.created_at, p.id
      )
      FROM public.receipt_share_participants p
      WHERE p.receipt_id = r.id
    ), '[]'::jsonb)
  )
  INTO v_payload
  FROM public.receipts r
  WHERE r.id = v_id;

  RETURN v_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.share_name_is_human(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_share_participant_names(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.share_person_name(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_share_participants(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_shared_receipt_splits(uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_shared_bill(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_bill(text) TO anon, authenticated;
