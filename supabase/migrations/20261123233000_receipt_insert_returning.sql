-- createEmptyReceipt inserts host_id and then asks PostgREST for the row
-- back (.insert().select().single()). Postgres applies zt_receipts_select as
-- a second WITH CHECK on that RETURNING clause. The select policy was only
-- public.can_access_receipt(id), which reads public.receipts again and does
-- not see the row being inserted, so the write was rejected with 42501.
-- The host is allowed to read the new row directly from host_id. A before
-- insert trigger stamps host_id from auth.uid() so the stored owner and the
-- session cannot diverge. anon stays blocked: the policy is TO authenticated
-- and the trigger function is not executable by anon.

CREATE OR REPLACE FUNCTION public.assign_receipt_host()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.host_id := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_receipt_host() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_receipt_host() TO authenticated;

DROP TRIGGER IF EXISTS receipts_assign_host ON public.receipts;
CREATE TRIGGER receipts_assign_host
  BEFORE INSERT ON public.receipts
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_receipt_host();

DROP POLICY IF EXISTS zt_receipts_insert ON public.receipts;
CREATE POLICY zt_receipts_insert
  ON public.receipts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    host_id = (SELECT auth.uid())
    AND (group_id IS NULL OR public.is_group_member(group_id))
  );

DROP POLICY IF EXISTS zt_receipts_select ON public.receipts;
CREATE POLICY zt_receipts_select
  ON public.receipts
  FOR SELECT
  TO authenticated
  USING (
    host_id = (SELECT auth.uid())
    OR paid_by = (SELECT auth.uid())
    OR public.can_access_receipt(id)
  );
