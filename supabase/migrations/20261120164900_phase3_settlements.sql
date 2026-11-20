-- Phase 3 settlement ledger. Append-only: reversals set voided_at and never DELETE.
-- Amounts are integer minor units (pence). £12.48 = 1248.

CREATE TABLE IF NOT EXISTS public.settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES auth.users(id),
  to_user_id uuid NOT NULL REFERENCES auth.users(id),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'GBP',
  idempotency_key text NOT NULL,
  payment_method text NOT NULL DEFAULT 'manual' CHECK (payment_method IN ('manual', 'payment_link', 'open_banking')),
  note text NULL,
  voided_at timestamptz NULL,
  voided_by uuid NULL REFERENCES auth.users(id),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlements_distinct_users CHECK (from_user_id <> to_user_id),
  CONSTRAINT settlements_group_idempotency_unique UNIQUE (group_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_settlements_group_id
  ON public.settlements (group_id);

CREATE INDEX IF NOT EXISTS idx_settlements_group_active
  ON public.settlements (group_id, created_at DESC)
  WHERE voided_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_settlements_from_user
  ON public.settlements (from_user_id);

CREATE INDEX IF NOT EXISTS idx_settlements_to_user
  ON public.settlements (to_user_id);

ALTER TABLE public.settlements ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.settlements FROM anon, authenticated;
GRANT SELECT ON TABLE public.settlements TO authenticated;

DO $$
BEGIN
  DROP POLICY IF EXISTS settlements_select_group_member ON public.settlements;
  CREATE POLICY settlements_select_group_member
    ON public.settlements
    FOR SELECT
    TO authenticated
    USING (
      group_id IN (
        SELECT gm.group_id
        FROM public.group_members gm
        WHERE gm.user_id = (SELECT auth.uid())
      )
    );
END $$;

CREATE OR REPLACE FUNCTION public.record_settlement(
  p_group_id uuid,
  p_from_user_id uuid,
  p_to_user_id uuid,
  p_amount_minor integer,
  p_idempotency_key text,
  p_payment_method text DEFAULT 'manual',
  p_note text DEFAULT NULL
) RETURNS public.settlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid;
  v_existing public.settlements%ROWTYPE;
  v_inserted public.settlements%ROWTYPE;
  v_method text;
BEGIN
  v_actor := (SELECT auth.uid());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_amount_minor IS NULL OR p_amount_minor <= 0 THEN
    RAISE EXCEPTION 'Amount must be positive';
  END IF;

  IF p_from_user_id IS NULL OR p_to_user_id IS NULL OR p_from_user_id = p_to_user_id THEN
    RAISE EXCEPTION 'Settlement parties must be different users';
  END IF;

  IF p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'Invalid idempotency key';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND gm.user_id = v_actor
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND gm.user_id = p_from_user_id
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND gm.user_id = p_to_user_id
  ) THEN
    RAISE EXCEPTION 'Forbidden: all parties must be group members';
  END IF;

  SELECT *
  INTO v_existing
  FROM public.settlements
  WHERE group_id = p_group_id
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    RETURN v_existing;
  END IF;

  v_method := COALESCE(p_payment_method, 'manual');

  BEGIN
    INSERT INTO public.settlements (
      id,
      group_id,
      from_user_id,
      to_user_id,
      amount_minor,
      currency,
      idempotency_key,
      payment_method,
      note,
      created_by
    ) VALUES (
      pg_catalog.gen_random_uuid(),
      p_group_id,
      p_from_user_id,
      p_to_user_id,
      p_amount_minor,
      'GBP',
      p_idempotency_key,
      v_method,
      p_note,
      v_actor
    )
    RETURNING * INTO v_inserted;

    RETURN v_inserted;
  EXCEPTION
    WHEN unique_violation THEN
      SELECT *
      INTO v_existing
      FROM public.settlements
      WHERE group_id = p_group_id
        AND idempotency_key = p_idempotency_key;

      IF NOT FOUND THEN
        RAISE;
      END IF;

      RETURN v_existing;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.record_settlement(uuid, uuid, uuid, integer, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_settlement(uuid, uuid, uuid, integer, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.void_settlement(
  p_settlement_id uuid
) RETURNS public.settlements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid;
  v_row public.settlements%ROWTYPE;
BEGIN
  v_actor := (SELECT auth.uid());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT *
  INTO v_row
  FROM public.settlements
  WHERE id = p_settlement_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = v_row.group_id
      AND gm.user_id = v_actor
  ) OR NOT (
    v_actor = v_row.created_by
    OR v_actor = v_row.to_user_id
    OR v_actor = v_row.from_user_id
  ) THEN
    RAISE EXCEPTION 'Forbidden: you cannot void this settlement';
  END IF;

  IF v_row.voided_at IS NOT NULL THEN
    RETURN v_row;
  END IF;

  UPDATE public.settlements
  SET voided_at = pg_catalog.now(),
      voided_by = v_actor
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.void_settlement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_settlement(uuid) TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'payment_link'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN payment_link text NULL;
  END IF;
END $$;
