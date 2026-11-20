-- Manual receipt archive. settled_at is a visual watermark only.
-- It must never insert, update, or delete public.settlements or public.receipt_splits.
-- Receipt ownership is public.receipts.host_id.

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS settled_at timestamptz NULL;

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS settled_by uuid NULL REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_receipts_group_settled
  ON public.receipts (group_id, settled_at, created_at DESC);

REVOKE UPDATE (settled_at, settled_by) ON TABLE public.receipts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_receipt_settled(
  p_receipt_id uuid,
  p_settled boolean
) RETURNS public.receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid;
  v_row public.receipts%ROWTYPE;
BEGIN
  v_actor := (SELECT auth.uid());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT *
  INTO v_row
  FROM public.receipts
  WHERE id = p_receipt_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_actor IS DISTINCT FROM v_row.host_id AND NOT (
    v_row.group_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM public.group_members gm
      WHERE gm.group_id = v_row.group_id
        AND gm.user_id = v_actor
    )
  ) THEN
    RAISE EXCEPTION 'Forbidden: you do not have permission to update this receipt' USING ERRCODE = '42501';
  END IF;

  IF p_settled IS TRUE THEN
    IF v_row.settled_at IS NOT NULL THEN
      RETURN v_row;
    END IF;

    UPDATE public.receipts
    SET settled_at = pg_catalog.now(),
        settled_by = v_actor
    WHERE id = p_receipt_id
    RETURNING * INTO v_row;

    RETURN v_row;
  END IF;

  IF p_settled IS FALSE THEN
    IF v_row.settled_at IS NULL THEN
      RETURN v_row;
    END IF;

    UPDATE public.receipts
    SET settled_at = NULL,
        settled_by = NULL
    WHERE id = p_receipt_id
    RETURNING * INTO v_row;

    RETURN v_row;
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.set_receipt_settled(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_receipt_settled(uuid, boolean) TO authenticated;
