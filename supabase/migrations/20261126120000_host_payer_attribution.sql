-- Host payer name and pre-claim settlement.
--
-- Guests still have no table privileges. The share payload gains is_host and
-- a public display name only: first name, else full name, else "Host".
-- Phone, email, and bank fields stay out of that name.
-- A host participant cannot be marked paid, and their own share is left out
-- of receipt_splits when they are the payer.

ALTER TABLE public.receipt_share_participants
  ADD COLUMN IF NOT EXISTS is_host boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.share_public_host_name(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name text;
BEGIN
  v_name := public.share_person_name(p_user_id, 'Host');
  IF v_name IS NULL
    OR position('@' in v_name) > 0
    OR v_name ~ '[[:cntrl:]]'
    OR v_name ~ '[0-9]{2}-[0-9]{2}-[0-9]{2}'
    OR v_name ~ '[0-9]{6}'
  THEN
    RETURN 'Host';
  END IF;
  RETURN v_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_host_share_payment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_host uuid;
BEGIN
  SELECT r.host_id INTO v_host FROM public.receipts r WHERE r.id = NEW.receipt_id;
  IF NEW.is_host OR (v_host IS NOT NULL AND NEW.user_id IS NOT DISTINCT FROM v_host) THEN
    NEW.is_host := true;
    NEW.is_paid := false;
    NEW.paid_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS receipt_share_participants_host_settled ON public.receipt_share_participants;
CREATE TRIGGER receipt_share_participants_host_settled
  BEFORE INSERT OR UPDATE ON public.receipt_share_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_host_share_payment();

UPDATE public.receipt_share_participants p
SET is_host = true
FROM public.receipts r
WHERE p.receipt_id = r.id
  AND p.user_id = r.host_id
  AND p.is_guest = false
  AND p.is_host = false;

CREATE UNIQUE INDEX IF NOT EXISTS receipt_share_participants_one_host
  ON public.receipt_share_participants (receipt_id)
  WHERE is_host;

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

  INSERT INTO public.receipt_share_participants (receipt_id, user_id, display_name, is_guest, is_host)
  VALUES (p_receipt_id, v_host, public.share_public_host_name(v_host), false, true)
  ON CONFLICT (receipt_id, user_id) WHERE user_id IS NOT NULL DO NOTHING;

  IF v_group IS NOT NULL AND to_regclass('public.group_members') IS NOT NULL THEN
    FOR v_member IN
      SELECT gm.user_id
      FROM public.group_members gm
      WHERE gm.group_id = v_group
        AND gm.user_id IS DISTINCT FROM v_host
    LOOP
      INSERT INTO public.receipt_share_participants (receipt_id, user_id, display_name, is_guest, is_host)
      VALUES (p_receipt_id, v_member, public.share_person_name(v_member, 'Member'), false, false)
      ON CONFLICT (receipt_id, user_id) WHERE user_id IS NOT NULL DO NOTHING;
    END LOOP;
  END IF;

  PERFORM public.refresh_share_participant_names(p_receipt_id);

  UPDATE public.receipt_share_participants
  SET is_host = true,
      display_name = public.share_public_host_name(v_host)
  WHERE receipt_id = p_receipt_id
    AND user_id = v_host
    AND is_guest = false;
END;
$$;

CREATE OR REPLACE FUNCTION public.share_split_is_self_payment(p_user_id uuid, p_receipt_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_user_id IS NOT DISTINCT FROM (
    SELECT COALESCE(r.paid_by, r.host_id)
    FROM public.receipts r
    WHERE r.id = p_receipt_id
  );
$$;

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
      AND p.amount_owed_pence > 0
      AND NOT public.share_split_is_self_payment(p.user_id, p.receipt_id);
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
      AND p.amount_owed_pence > 0
      AND NOT public.share_split_is_self_payment(p.user_id, p.receipt_id);
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
      AND p.amount_owed_pence > 0
      AND NOT public.share_split_is_self_payment(p.user_id, p.receipt_id);
  ELSE
    INSERT INTO public.receipt_splits (receipt_id, user_id, amount_minor, updated_at)
    SELECT p.receipt_id, p.user_id, p.amount_owed_pence, now()
    FROM public.receipt_share_participants p
    WHERE p.receipt_id = p_receipt_id
      AND p.user_id IS NOT NULL
      AND p.amount_owed_pence > 0
      AND NOT public.share_split_is_self_payment(p.user_id, p.receipt_id);
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

DROP FUNCTION IF EXISTS public.recalculate_shared_bill(uuid);

CREATE OR REPLACE FUNCTION public.recalculate_shared_bill(p_receipt_id uuid, p_sync_splits boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total bigint;
  v_service bigint;
  v_lines bigint := 0;
  v_item record;
  v_ids uuid[];
  v_count int;
  v_base bigint;
  v_rem bigint;
  v_index int;
BEGIN
  UPDATE public.receipt_share_participants
  SET items_subtotal_pence = 0,
      service_charge_pence = 0,
      amount_owed_pence = 0
  WHERE receipt_id = p_receipt_id;

  SELECT
    GREATEST(round(COALESCE(total_amount, 0) * 100)::bigint, 0),
    GREATEST(round(COALESCE(service_charge, 0) * 100)::bigint, 0)
  INTO v_total, v_service
  FROM public.receipts
  WHERE id = p_receipt_id;

  FOR v_item IN
    SELECT
      i.id,
      GREATEST(round(COALESCE(i.price, 0) * 100)::bigint, 0)
        * GREATEST(COALESCE(i.quantity, 1), 1)::bigint AS line_pence
    FROM public.items i
    WHERE i.receipt_id = p_receipt_id
  LOOP
    v_lines := v_lines + v_item.line_pence;
    SELECT COALESCE(array_agg(c.participant_id ORDER BY c.participant_id), ARRAY[]::uuid[])
    INTO v_ids
    FROM public.receipt_share_claims c
    WHERE c.item_id = v_item.id;

    v_count := COALESCE(array_length(v_ids, 1), 0);
    IF v_count = 0 THEN
      CONTINUE;
    END IF;

    v_base := v_item.line_pence / v_count;
    v_rem := v_item.line_pence % v_count;
    FOR v_index IN 1..v_count LOOP
      UPDATE public.receipt_share_participants
      SET items_subtotal_pence = items_subtotal_pence + v_base
        + CASE WHEN v_index <= v_rem THEN 1 ELSE 0 END
      WHERE id = v_ids[v_index];
    END LOOP;
  END LOOP;

  UPDATE public.receipt_share_participants p
  SET amount_owed_pence = p.items_subtotal_pence + s.share_pence
  FROM public.share_largest_remainder(p_receipt_id, GREATEST(v_total - v_lines, 0)) s
  WHERE p.id = s.participant_id;

  UPDATE public.receipt_share_participants p
  SET service_charge_pence = s.share_pence
  FROM public.share_largest_remainder(p_receipt_id, v_service) s
  WHERE p.id = s.participant_id;

  IF p_sync_splits THEN
    PERFORM public.sync_shared_receipt_splits(p_receipt_id);
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

  v_owner_name := public.share_public_host_name(v_host);
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
      'host_display_name', v_owner_name,
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
                'display_name', CASE
                  WHEN p.is_host OR p.user_id = v_host THEN v_owner_name
                  ELSE p.display_name
                END,
                'is_host', (p.is_host OR p.user_id = v_host)
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
          'display_name', CASE
            WHEN p.is_host OR p.user_id = v_host THEN v_owner_name
            ELSE p.display_name
          END,
          'is_host', (p.is_host OR p.user_id = v_host),
          'amount_owed', to_char(p.amount_owed_pence / 100.0, 'FM999999990.00'),
          'amount_owed_pence', p.amount_owed_pence,
          'items_subtotal_pence', p.items_subtotal_pence,
          'service_charge_pence', p.service_charge_pence,
          'is_paid', CASE WHEN p.is_host OR p.user_id = v_host THEN true ELSE p.is_paid END,
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

CREATE OR REPLACE FUNCTION public.update_shared_bill_claim(
  p_share_token text,
  p_action text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_host uuid;
  v_payload jsonb;
  v_item uuid;
  v_participant uuid;
  v_name text;
  v_paid boolean;
  v_item_text text;
  v_participant_text text;
BEGIN
  IF NOT public.share_token_is_usable(p_share_token) THEN
    RAISE EXCEPTION 'invalid share token' USING ERRCODE = '22023';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('toggle_item_claim', 'set_paid_status') THEN
    RAISE EXCEPTION 'unsupported action' USING ERRCODE = '22023';
  END IF;

  v_payload := COALESCE(p_payload, '{}'::jsonb);

  SELECT r.id, r.host_id
  INTO v_id, v_host
  FROM public.receipts r
  WHERE r.share_token = p_share_token
    AND r.share_enabled = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM public.seed_share_participants(v_id);

  IF p_action = 'set_paid_status' THEN
    v_participant_text := v_payload->>'participant_id';
    IF v_participant_text IS NULL OR v_participant_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid participant' USING ERRCODE = '22023';
    END IF;
    v_participant := v_participant_text::uuid;
    IF jsonb_typeof(v_payload->'is_paid') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'is_paid must be true or false' USING ERRCODE = '22023';
    END IF;
    v_paid := (v_payload->>'is_paid')::boolean;

    IF EXISTS (
      SELECT 1
      FROM public.receipt_share_participants p
      WHERE p.id = v_participant
        AND p.receipt_id = v_id
        AND (p.is_host OR p.user_id IS NOT DISTINCT FROM v_host)
    ) THEN
      RAISE EXCEPTION 'host share is already settled' USING ERRCODE = '22023';
    END IF;

    UPDATE public.receipt_share_participants
    SET is_paid = v_paid,
        paid_at = CASE WHEN v_paid THEN now() ELSE NULL END
    WHERE id = v_participant
      AND receipt_id = v_id
      AND is_host = false
      AND user_id IS DISTINCT FROM v_host;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid participant' USING ERRCODE = '22023';
    END IF;

    RETURN public.get_shared_bill(p_share_token);
  END IF;

  v_item_text := v_payload->>'item_id';
  v_participant_text := v_payload->>'participant_id';

  IF v_item_text IS NOT NULL AND v_item_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid item' USING ERRCODE = '22023';
  END IF;
  IF v_participant_text IS NOT NULL AND v_participant_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid participant' USING ERRCODE = '22023';
  END IF;

  v_item := CASE WHEN v_item_text IS NULL THEN NULL ELSE v_item_text::uuid END;
  v_participant := CASE WHEN v_participant_text IS NULL THEN NULL ELSE v_participant_text::uuid END;

  IF v_participant IS NULL THEN
    IF v_payload->>'display_name' IS NULL THEN
      RAISE EXCEPTION 'Choose who is claiming' USING ERRCODE = '22023';
    END IF;
    v_name := public.require_share_guest_name(v_payload->>'display_name');
    SELECT p.id
    INTO v_participant
    FROM public.receipt_share_participants p
    WHERE p.receipt_id = v_id
      AND p.is_guest = true
      AND lower(p.display_name) = lower(v_name)
    ORDER BY p.created_at, p.id
    LIMIT 1;

    IF v_participant IS NULL THEN
      INSERT INTO public.receipt_share_participants (receipt_id, user_id, display_name, is_guest, is_host)
      VALUES (v_id, NULL, v_name, true, false)
      RETURNING id INTO v_participant;
    END IF;
  ELSE
    PERFORM 1
    FROM public.receipt_share_participants p
    WHERE p.id = v_participant
      AND p.receipt_id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid participant' USING ERRCODE = '22023';
    END IF;
  END IF;

  IF v_item IS NULL THEN
    RETURN public.get_shared_bill(p_share_token);
  END IF;

  PERFORM 1
  FROM public.items i
  WHERE i.id = v_item
    AND i.receipt_id = v_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid item' USING ERRCODE = '22023';
  END IF;

  IF v_participant_text IS NULL THEN
    INSERT INTO public.receipt_share_claims (receipt_id, item_id, participant_id)
    VALUES (v_id, v_item, v_participant)
    ON CONFLICT (item_id, participant_id) DO NOTHING;
  ELSIF EXISTS (
    SELECT 1
    FROM public.receipt_share_claims c
    WHERE c.item_id = v_item
      AND c.participant_id = v_participant
  ) THEN
    DELETE FROM public.receipt_share_claims
    WHERE item_id = v_item
      AND participant_id = v_participant;
  ELSE
    INSERT INTO public.receipt_share_claims (receipt_id, item_id, participant_id)
    VALUES (v_id, v_item, v_participant);
  END IF;

  PERFORM public.recalculate_shared_bill(v_id);
  RETURN public.get_shared_bill(p_share_token);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_host_claim_state(p_receipt_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_host uuid;
  v_name text;
  v_participant uuid;
  v_owed bigint;
  v_total bigint;
  v_assigned bigint;
  v_items int;
  v_claimed int;
  v_ids jsonb;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL OR p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  SELECT r.host_id
  INTO v_host
  FROM public.receipts r
  WHERE r.id = p_receipt_id;

  IF v_host IS NULL OR v_actor IS DISTINCT FROM v_host THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  PERFORM public.seed_share_participants(p_receipt_id);
  v_name := public.share_public_host_name(v_host);

  SELECT p.id, p.amount_owed_pence
  INTO v_participant, v_owed
  FROM public.receipt_share_participants p
  WHERE p.receipt_id = p_receipt_id
    AND (p.is_host OR p.user_id = v_host)
  ORDER BY p.is_host DESC, p.created_at, p.id
  LIMIT 1;

  SELECT COALESCE(jsonb_agg(c.item_id ORDER BY c.item_id), '[]'::jsonb)
  INTO v_ids
  FROM public.receipt_share_claims c
  WHERE c.participant_id = v_participant;

  SELECT
    GREATEST(round(COALESCE(r.total_amount, 0) * 100)::bigint, 0),
    (SELECT count(*)::int FROM public.items i WHERE i.receipt_id = r.id),
    (SELECT count(DISTINCT c.item_id)::int FROM public.receipt_share_claims c WHERE c.receipt_id = r.id),
    COALESCE((SELECT SUM(p.amount_owed_pence) FROM public.receipt_share_participants p WHERE p.receipt_id = r.id), 0)
  INTO v_total, v_items, v_claimed, v_assigned
  FROM public.receipts r
  WHERE r.id = p_receipt_id;

  RETURN jsonb_build_object(
    'host_display_name', v_name,
    'claimed_item_ids', COALESCE(v_ids, '[]'::jsonb),
    'amount_owed_pence', COALESCE(v_owed, 0),
    'unclaimed_pence', GREATEST(COALESCE(v_total, 0) - COALESCE(v_assigned, 0), 0),
    'items_claimed', COALESCE(v_claimed, 0),
    'items_total', COALESCE(v_items, 0)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_host_item_claims(p_receipt_id uuid, p_item_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid;
  v_host uuid;
  v_participant uuid;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL OR p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_item_ids IS NULL OR cardinality(p_item_ids) > 400 THEN
    RAISE EXCEPTION 'invalid item' USING ERRCODE = '22023';
  END IF;

  SELECT r.host_id
  INTO v_host
  FROM public.receipts r
  WHERE r.id = p_receipt_id
  FOR UPDATE;

  IF v_host IS NULL OR v_actor IS DISTINCT FROM v_host THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_item_ids) AS wanted(id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.items i
      WHERE i.id = wanted.id
        AND i.receipt_id = p_receipt_id
    )
  ) THEN
    RAISE EXCEPTION 'invalid item' USING ERRCODE = '22023';
  END IF;

  PERFORM public.seed_share_participants(p_receipt_id);

  SELECT p.id
  INTO v_participant
  FROM public.receipt_share_participants p
  WHERE p.receipt_id = p_receipt_id
    AND p.user_id = v_host
    AND p.is_guest = false
  ORDER BY p.is_host DESC, p.created_at, p.id
  LIMIT 1;

  IF v_participant IS NULL THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE = '42501';
  END IF;

  UPDATE public.receipt_share_participants
  SET is_host = true
  WHERE id = v_participant
    AND is_host = false;

  DELETE FROM public.receipt_share_claims c
  WHERE c.participant_id = v_participant
    AND NOT (c.item_id = ANY (p_item_ids));

  INSERT INTO public.receipt_share_claims (receipt_id, item_id, participant_id)
  SELECT DISTINCT p_receipt_id, wanted.id, v_participant
  FROM unnest(p_item_ids) AS wanted(id)
  ON CONFLICT (item_id, participant_id) DO NOTHING;

  PERFORM public.recalculate_shared_bill(p_receipt_id, false);
  RETURN public.get_host_claim_state(p_receipt_id);
END;
$$;

REVOKE ALL ON FUNCTION public.share_public_host_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_host_share_payment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.share_split_is_self_payment(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.seed_share_participants(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_shared_receipt_splits(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recalculate_shared_bill(uuid, boolean) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_shared_bill(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_bill(text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.update_shared_bill_claim(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_shared_bill_claim(text, text, jsonb) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_host_claim_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_host_claim_state(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.set_host_item_claims(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_host_item_claims(uuid, uuid[]) TO authenticated;
