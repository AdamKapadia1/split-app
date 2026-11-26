-- Live split countdown.
-- host_confirmed_at is the host's explicit item confirmation.
-- Guests still have no SELECT on receipts, profiles, or share tables.
-- Realtime carries only a token, an event name, and a timestamp.

ALTER TABLE public.receipt_share_participants
  ADD COLUMN IF NOT EXISTS host_confirmed_at timestamptz;

UPDATE public.receipt_share_participants p
SET host_confirmed_at = p.created_at
WHERE p.is_host = true
  AND p.host_confirmed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.receipt_share_claims c
    WHERE c.participant_id = p.id
  );

CREATE OR REPLACE FUNCTION public.guard_host_claim_writer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_participant uuid;
  v_host uuid;
  v_is_host boolean;
  v_user uuid;
BEGIN
  v_participant := COALESCE(NEW.participant_id, OLD.participant_id);
  SELECT p.is_host, p.user_id, r.host_id
  INTO v_is_host, v_user, v_host
  FROM public.receipt_share_participants p
  JOIN public.receipts r ON r.id = p.receipt_id
  WHERE p.id = v_participant;

  IF COALESCE(v_is_host, false) OR (v_host IS NOT NULL AND v_user IS NOT DISTINCT FROM v_host) THEN
    IF auth.uid() IS DISTINCT FROM v_host THEN
      RAISE EXCEPTION 'host items are confirmed by the host' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS receipt_share_claims_host_writer ON public.receipt_share_claims;
CREATE TRIGGER receipt_share_claims_host_writer
  BEFORE INSERT OR DELETE ON public.receipt_share_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_host_claim_writer();

REVOKE ALL ON FUNCTION public.guard_host_claim_writer() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.broadcast_split_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_receipt uuid;
  v_token text;
BEGIN
  v_receipt := COALESCE(NEW.receipt_id, OLD.receipt_id);
  SELECT r.share_token
  INTO v_token
  FROM public.receipts r
  WHERE r.id = v_receipt
    AND r.share_enabled = true;

  IF v_token IS NULL OR char_length(v_token) < 20 THEN
    RETURN NULL;
  END IF;

  BEGIN
    PERFORM realtime.send(
      jsonb_build_object(
        'share_token', v_token,
        'event_type', TG_OP,
        'ts', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ),
      'sync',
      'split-sync:' || v_token,
      false
    );
  EXCEPTION
    WHEN undefined_function OR invalid_schema_name THEN
      PERFORM pg_notify(
        'split-sync',
        jsonb_build_object(
          'share_token', v_token,
          'event_type', TG_OP,
          'ts', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        )::text
      );
  END;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS receipt_share_claims_broadcast ON public.receipt_share_claims;
CREATE TRIGGER receipt_share_claims_broadcast
  AFTER INSERT OR UPDATE OR DELETE ON public.receipt_share_claims
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_split_sync();

DROP TRIGGER IF EXISTS receipt_share_participants_broadcast ON public.receipt_share_participants;
CREATE TRIGGER receipt_share_participants_broadcast
  AFTER INSERT OR UPDATE OR DELETE ON public.receipt_share_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_split_sync();

REVOKE ALL ON FUNCTION public.broadcast_split_sync() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.receipt_share_claims;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.receipt_share_participants;
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.recalculate_shared_bill(p_receipt_id uuid, p_sync_splits boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total bigint;
  v_weight bigint := 0;
  v_base_sum bigint := 0;
  v_leftover bigint := 0;
  v_item record;
  v_count int;
  v_base bigint;
  v_rem bigint;
  v_index int;
  v_ids uuid[];
BEGIN
  UPDATE public.receipt_share_participants
  SET items_subtotal_pence = 0,
      service_charge_pence = 0,
      amount_owed_pence = 0
  WHERE receipt_id = p_receipt_id;

  SELECT GREATEST(round(COALESCE(total_amount, 0) * 100)::bigint, 0)
  INTO v_total
  FROM public.receipts
  WHERE id = p_receipt_id;

  DROP TABLE IF EXISTS pg_temp.item_pence_alloc;
  CREATE TEMP TABLE item_pence_alloc (
    item_id uuid PRIMARY KEY,
    line_pence bigint NOT NULL,
    adjusted_pence bigint NOT NULL,
    fraction bigint NOT NULL
  ) ON COMMIT DROP;

  INSERT INTO item_pence_alloc (item_id, line_pence, adjusted_pence, fraction)
  SELECT
    i.id,
    GREATEST(round(COALESCE(i.price, 0) * 100)::bigint, 0) * GREATEST(COALESCE(i.quantity, 1), 1)::bigint,
    0,
    0
  FROM public.items i
  WHERE i.receipt_id = p_receipt_id;

  SELECT COALESCE(SUM(line_pence), 0) INTO v_weight FROM item_pence_alloc;

  IF v_weight = v_total THEN
    UPDATE item_pence_alloc SET adjusted_pence = line_pence;
  ELSIF v_weight <= 0 THEN
    SELECT count(*) INTO v_count FROM item_pence_alloc;
    IF v_count > 0 THEN
      v_base := v_total / v_count;
      v_rem := v_total % v_count;
      UPDATE item_pence_alloc AS row
      SET adjusted_pence = v_base + CASE WHEN ranked.rank <= v_rem THEN 1 ELSE 0 END
      FROM (
        SELECT item_id, ROW_NUMBER() OVER (ORDER BY item_id) AS rank
        FROM item_pence_alloc
      ) ranked
      WHERE row.item_id = ranked.item_id;
    END IF;
  ELSE
    UPDATE item_pence_alloc
    SET
      adjusted_pence = (v_total * line_pence) / v_weight,
      fraction = (v_total * line_pence) % v_weight;
    SELECT COALESCE(SUM(adjusted_pence), 0) INTO v_base_sum FROM item_pence_alloc;
    v_leftover := v_total - v_base_sum;
    IF v_leftover > 0 THEN
      UPDATE item_pence_alloc AS row
      SET adjusted_pence = row.adjusted_pence + 1
      FROM (
        SELECT item_id, ROW_NUMBER() OVER (ORDER BY fraction DESC, item_id ASC) AS rank
        FROM item_pence_alloc
      ) ranked
      WHERE row.item_id = ranked.item_id
        AND ranked.rank <= v_leftover;
    END IF;
  END IF;

  FOR v_item IN
    SELECT item_id, line_pence, adjusted_pence FROM item_pence_alloc
  LOOP
    SELECT COALESCE(array_agg(c.participant_id ORDER BY c.participant_id), ARRAY[]::uuid[])
    INTO v_ids
    FROM public.receipt_share_claims c
    WHERE c.item_id = v_item.item_id;

    v_count := COALESCE(array_length(v_ids, 1), 0);
    IF v_count = 0 THEN
      CONTINUE;
    END IF;

    v_base := v_item.line_pence / v_count;
    v_rem := v_item.line_pence % v_count;
    FOR v_index IN 1..v_count LOOP
      UPDATE public.receipt_share_participants
      SET items_subtotal_pence = items_subtotal_pence + v_base + CASE WHEN v_index <= v_rem THEN 1 ELSE 0 END
      WHERE id = v_ids[v_index];
    END LOOP;

    v_base := v_item.adjusted_pence / v_count;
    v_rem := v_item.adjusted_pence % v_count;
    FOR v_index IN 1..v_count LOOP
      UPDATE public.receipt_share_participants
      SET amount_owed_pence = amount_owed_pence + v_base + CASE WHEN v_index <= v_rem THEN 1 ELSE 0 END
      WHERE id = v_ids[v_index];
    END LOOP;
  END LOOP;

  UPDATE public.receipt_share_participants
  SET service_charge_pence = GREATEST(amount_owed_pence - items_subtotal_pence, 0)
  WHERE receipt_id = p_receipt_id;

  IF p_sync_splits THEN
    PERFORM public.sync_shared_receipt_splits(p_receipt_id);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_shared_bill(uuid, boolean) FROM PUBLIC, anon, authenticated;


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
      'created_at', r.created_at,
      'host_confirmed_at', (
        SELECT p.host_confirmed_at
        FROM public.receipt_share_participants p
        WHERE p.receipt_id = r.id
          AND p.is_host
        ORDER BY p.created_at, p.id
        LIMIT 1
      ),
      'viewer_is_host', (auth.uid() IS NOT DISTINCT FROM v_host)
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
  v_confirmed timestamptz;
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

  SELECT p.id, p.amount_owed_pence, p.host_confirmed_at
  INTO v_participant, v_owed, v_confirmed
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
    'items_total', COALESCE(v_items, 0),
    'host_confirmed_at', v_confirmed
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_host_items(p_receipt_id uuid, p_item_ids uuid[])
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
  SET is_host = true,
      host_confirmed_at = clock_timestamp()
  WHERE id = v_participant;

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

REVOKE ALL ON FUNCTION public.get_host_claim_state(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_host_claim_state(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.confirm_host_items(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_host_items(uuid, uuid[]) TO authenticated;
