-- Keep receipts.status aligned with the share ledger.
-- confirm_host_items, set_host_item_claims, and update_shared_bill_claim
-- all finish in recalculate_shared_bill, which calls the sync below.
-- Every UPDATE filters on receipts.id so pg_safeupdate allows it.
-- Mark Settled uses status 'settled' together with settled_at.

DO $widen$
DECLARE
  v_type text;
  v_udt text;
  v_constraint record;
BEGIN
  SELECT c.data_type, c.udt_name
  INTO v_type, v_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = 'receipts'
    AND c.column_name = 'status';

  IF v_type = 'USER-DEFINED' AND v_udt IS NOT NULL THEN
    EXECUTE format('ALTER TYPE public.%I ADD VALUE IF NOT EXISTS %L', v_udt, 'unsplit');
    EXECUTE format('ALTER TYPE public.%I ADD VALUE IF NOT EXISTS %L', v_udt, 'split');
  ELSE
    FOR v_constraint IN
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
      WHERE nsp.nspname = 'public'
        AND rel.relname = 'receipts'
        AND con.contype = 'c'
        AND pg_get_constraintdef(con.oid) ILIKE '%status%'
    LOOP
      EXECUTE format('ALTER TABLE public.receipts DROP CONSTRAINT %I', v_constraint.conname);
    END LOOP;

    ALTER TABLE public.receipts
      DROP CONSTRAINT IF EXISTS receipts_status_values;
    ALTER TABLE public.receipts
      ADD CONSTRAINT receipts_status_values
      CHECK (status IN ('scanning', 'open', 'locked', 'unsplit', 'split', 'settled'));
  END IF;
END
$widen$;

CREATE OR REPLACE FUNCTION public.sync_receipt_status_from_share(p_receipt_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_total bigint := 0;
  v_host bigint := 0;
  v_unpaid bigint := 0;
  v_paid bigint := 0;
  v_claimed bigint := 0;
  v_remaining bigint := 0;
  v_status text;
BEGIN
  IF p_receipt_id IS NULL THEN
    RETURN;
  END IF;

  SELECT r.status
  INTO v_status
  FROM public.receipts r
  WHERE r.id = p_receipt_id;

  IF NOT FOUND OR v_status IN ('scanning', 'locked') THEN
    RETURN;
  END IF;

  SELECT GREATEST(round(COALESCE(r.total_amount, 0) * 100)::bigint, 0)
  INTO v_total
  FROM public.receipts r
  WHERE r.id = p_receipt_id;

  SELECT COALESCE(SUM(p.amount_owed_pence), 0)
  INTO v_host
  FROM public.receipt_share_participants p
  WHERE p.receipt_id = p_receipt_id
    AND p.is_host = true
    AND p.host_confirmed_at IS NOT NULL;

  SELECT COALESCE(SUM(p.amount_owed_pence), 0)
  INTO v_unpaid
  FROM public.receipt_share_participants p
  WHERE p.receipt_id = p_receipt_id
    AND p.is_host = false
    AND p.is_paid = false;

  SELECT COALESCE(SUM(p.amount_owed_pence), 0)
  INTO v_paid
  FROM public.receipt_share_participants p
  WHERE p.receipt_id = p_receipt_id
    AND p.is_host = false
    AND p.is_paid = true;

  v_claimed := v_host + v_unpaid + v_paid;
  v_remaining := GREATEST(v_total - v_host - v_paid, 0);

  IF v_claimed > 0 AND v_remaining = 0 THEN
    UPDATE public.receipts
    SET status = 'settled',
        settled_at = COALESCE(settled_at, clock_timestamp())
    WHERE id = p_receipt_id
      AND (
        status IS DISTINCT FROM 'settled'
        OR settled_at IS NULL
      );
  ELSIF v_claimed > 0 THEN
    UPDATE public.receipts
    SET status = 'split',
        settled_at = CASE WHEN settled_by IS NULL THEN NULL ELSE settled_at END
    WHERE id = p_receipt_id
      AND (
        status IS DISTINCT FROM 'split'
        OR (settled_by IS NULL AND settled_at IS NOT NULL)
      );
  ELSE
    UPDATE public.receipts
    SET status = 'unsplit',
        settled_at = CASE WHEN settled_by IS NULL THEN NULL ELSE settled_at END
    WHERE id = p_receipt_id
      AND (
        status IS DISTINCT FROM 'unsplit'
        OR (settled_by IS NULL AND settled_at IS NOT NULL)
      );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_receipt_status_from_share(uuid) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.receipts;
EXCEPTION
  WHEN duplicate_object OR undefined_object THEN NULL;
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

  PERFORM public.sync_receipt_status_from_share(p_receipt_id);

  IF p_sync_splits THEN
    PERFORM public.sync_shared_receipt_splits(p_receipt_id);
  END IF;
END;
$$;

