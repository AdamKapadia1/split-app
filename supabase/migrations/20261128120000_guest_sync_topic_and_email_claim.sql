-- Audit fixes H2 and M3. Additive and idempotent: CREATE OR REPLACE only,
-- with no table, column, or trigger changes. Every UPDATE keeps an explicit
-- WHERE clause (pg_safeupdate).
--
-- H2: marking a share unpaid no longer clears host_notified_at. A share gets
--     at most one host "paid" email, so paid -> unpaid -> paid toggles can
--     neither spam the host nor collide with the fixed Resend idempotency key.
--     notify-host-paid still clears its own claim if its send fails.
--
-- M3: broadcast_split_sync also sends to split-sync:<receipt_id> with a
--     payload that has no share token. The guest web page listens there.
--     The legacy split-sync:<share_token> send is kept, byte for byte, because
--     the shipped native host screen (iOS Build 12) still listens on it.
--     Remove it after every native build in use has moved to the receipt topic.

CREATE OR REPLACE FUNCTION public.broadcast_split_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_receipt uuid;
  v_token text;
  v_ts text;
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

  v_ts := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  -- Receipt-keyed topic for guest web. No share token in topic or payload.
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object(
        'receipt_id', v_receipt,
        'event_type', TG_OP,
        'ts', v_ts
      ),
      'sync',
      'split-sync:' || v_receipt::text,
      false
    );
  EXCEPTION
    WHEN undefined_function OR invalid_schema_name THEN
      NULL;
  END;

  -- Legacy token-keyed topic for shipped native builds. Unchanged.
  BEGIN
    PERFORM realtime.send(
      jsonb_build_object(
        'share_token', v_token,
        'event_type', TG_OP,
        'ts', v_ts
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
          'ts', v_ts
        )::text
      );
  END;

  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.broadcast_split_sync() FROM PUBLIC, anon, authenticated;

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
    -- host_notified_at is intentionally untouched: one host email per share.
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

GRANT EXECUTE ON FUNCTION public.update_shared_bill_claim(text, text, jsonb) TO anon, authenticated;
