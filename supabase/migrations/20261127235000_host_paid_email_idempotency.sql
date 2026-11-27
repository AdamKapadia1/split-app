-- Idempotent guest "I've paid" plus host email claim.
-- Repeat set_paid_status calls return the current bill and do not rewrite
-- paid_at, host_notified_at, receipts.status, or settled_at.
-- A real unpaid <-> paid change syncs receipts.status in the same transaction.

ALTER TABLE public.receipt_share_participants
  ADD COLUMN IF NOT EXISTS host_notified_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS receipt_share_participants_host_unnotified
  ON public.receipt_share_participants (id)
  WHERE host_notified_at IS NULL;

CREATE OR REPLACE FUNCTION public.sync_receipt_status_on_share_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP IS DISTINCT FROM 'UPDATE' THEN
    RETURN NULL;
  END IF;
  IF NEW.receipt_id IS NULL OR NEW.is_paid IS NOT DISTINCT FROM OLD.is_paid THEN
    RETURN NULL;
  END IF;

  PERFORM public.sync_receipt_status_from_share(NEW.receipt_id);
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_receipt_status_on_share_paid() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS receipt_share_participants_status_sync ON public.receipt_share_participants;
CREATE TRIGGER receipt_share_participants_status_sync
  AFTER UPDATE OF is_paid ON public.receipt_share_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_receipt_status_on_share_paid();

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
        paid_at = CASE WHEN v_paid THEN now() ELSE NULL END,
        host_notified_at = CASE WHEN v_paid THEN host_notified_at ELSE NULL END
    WHERE id = v_participant
      AND receipt_id = v_id
      AND is_host = false
      AND user_id IS DISTINCT FROM v_host
      AND is_paid IS DISTINCT FROM v_paid;

    IF NOT FOUND THEN
      IF EXISTS (
        SELECT 1
        FROM public.receipt_share_participants p
        WHERE p.id = v_participant
          AND p.receipt_id = v_id
          AND p.is_host = false
          AND p.user_id IS DISTINCT FROM v_host
          AND p.is_paid = v_paid
      ) THEN
        RETURN public.get_shared_bill(p_share_token);
      END IF;
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
