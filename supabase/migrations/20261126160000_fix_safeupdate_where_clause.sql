-- Hotfix: pg_safeupdate rejects UPDATE/DELETE without a WHERE clause.
-- Host confirmation calls recalculate_shared_bill, whose temp-table updates
-- had none. Every write below filters on a primary or foreign key.
-- The host label prefers a real profile or account name before "Host".

CREATE OR REPLACE FUNCTION public.share_person_name(p_user_id uuid, p_fallback text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_fallback text;
  v_choice text;
  v_raw text;
  v_column text;
  v_meta jsonb;
BEGIN
  v_fallback := public.sanitize_share_name(p_fallback);
  IF NOT public.share_name_is_human(v_fallback) OR lower(v_fallback) IN ('host', 'member') THEN
    v_fallback := NULL;
  END IF;

  IF p_user_id IS NOT NULL AND to_regclass('public.profiles') IS NOT NULL THEN
    FOREACH v_column IN ARRAY ARRAY['first_name', 'full_name', 'display_name', 'name']
    LOOP
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'profiles'
          AND column_name = v_column
      ) THEN
        EXECUTE format(
          'SELECT NULLIF(btrim(%I), '''') FROM public.profiles WHERE id = $1',
          v_column
        )
          INTO v_raw
          USING p_user_id;
        v_choice := public.sanitize_share_name(v_raw);
        IF public.share_name_is_human(v_choice) THEN
          RETURN v_choice;
        END IF;
      END IF;
    END LOOP;
  END IF;

  IF p_user_id IS NOT NULL AND to_regclass('auth.users') IS NOT NULL THEN
    BEGIN
      SELECT u.raw_user_meta_data
      INTO v_meta
      FROM auth.users u
      WHERE u.id = p_user_id;
    EXCEPTION
      WHEN undefined_table OR insufficient_privilege THEN
        v_meta := NULL;
    END;

    IF v_meta IS NOT NULL THEN
      FOREACH v_column IN ARRAY ARRAY['first_name', 'full_name', 'name', 'display_name']
      LOOP
        v_choice := public.sanitize_share_name(v_meta ->> v_column);
        IF public.share_name_is_human(v_choice) THEN
          RETURN v_choice;
        END IF;
      END LOOP;
    END IF;
  END IF;

  RETURN COALESCE(v_fallback, 'Member');
END;
$$;

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
  v_name := public.share_person_name(p_user_id, NULL);
  IF v_name IS NULL
    OR lower(v_name) IN ('host', 'member')
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
    UPDATE item_pence_alloc SET adjusted_pence = line_pence
    WHERE item_id IS NOT NULL;
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
      fraction = (v_total * line_pence) % v_weight
    WHERE item_id IS NOT NULL;
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
      WHERE id = v_ids[v_index]
        AND receipt_id = p_receipt_id;
    END LOOP;

    v_base := v_item.adjusted_pence / v_count;
    v_rem := v_item.adjusted_pence % v_count;
    FOR v_index IN 1..v_count LOOP
      UPDATE public.receipt_share_participants
      SET amount_owed_pence = amount_owed_pence + v_base + CASE WHEN v_index <= v_rem THEN 1 ELSE 0 END
      WHERE id = v_ids[v_index]
        AND receipt_id = p_receipt_id;
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
      host_confirmed_at = clock_timestamp(),
      display_name = public.share_public_host_name(v_host)
  WHERE id = v_participant
    AND receipt_id = p_receipt_id;

  DELETE FROM public.receipt_share_claims c
  WHERE c.participant_id = v_participant
    AND c.receipt_id = p_receipt_id
    AND NOT (c.item_id = ANY (p_item_ids));

  INSERT INTO public.receipt_share_claims (receipt_id, item_id, participant_id)
  SELECT DISTINCT p_receipt_id, wanted.id, v_participant
  FROM unnest(p_item_ids) AS wanted(id)
  ON CONFLICT (item_id, participant_id) DO NOTHING;

  PERFORM public.recalculate_shared_bill(p_receipt_id, false);
  RETURN public.get_host_claim_state(p_receipt_id);
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
  SET is_host = true,
      display_name = public.share_public_host_name(v_host)
  WHERE id = v_participant
    AND receipt_id = p_receipt_id;

  DELETE FROM public.receipt_share_claims c
  WHERE c.participant_id = v_participant
    AND c.receipt_id = p_receipt_id
    AND NOT (c.item_id = ANY (p_item_ids));

  INSERT INTO public.receipt_share_claims (receipt_id, item_id, participant_id)
  SELECT DISTINCT p_receipt_id, wanted.id, v_participant
  FROM unnest(p_item_ids) AS wanted(id)
  ON CONFLICT (item_id, participant_id) DO NOTHING;

  PERFORM public.recalculate_shared_bill(p_receipt_id, false);
  RETURN public.get_host_claim_state(p_receipt_id);
END;
$$;

UPDATE public.receipt_share_participants p
SET display_name = public.share_public_host_name(p.user_id)
WHERE p.id IS NOT NULL
  AND p.receipt_id IS NOT NULL
  AND p.is_host = true
  AND p.user_id IS NOT NULL
  AND p.display_name IS DISTINCT FROM public.share_public_host_name(p.user_id);

REVOKE ALL ON FUNCTION public.share_person_name(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.share_public_host_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recalculate_shared_bill(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_host_items(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_host_items(uuid, uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.set_host_item_claims(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_host_item_claims(uuid, uuid[]) TO authenticated;
