-- Scan saves were reported as a blanket permission error. Two leftovers from
-- the pre-zero-trust policies made that possible:
--   * "Users can delete own receipts" is granted to PUBLIC, so anon is a
--     candidate for that command.
--   * "Group members can read receipt splits" reads public.receipts as the
--     caller. Under forced RLS that re-enters the receipt policies.
-- Personal scans also called is_group_member even when group_id is null.
-- CASE stops that call. Storage clients need to see the private bucket row
-- before they can insert an object, so authenticated gets a select policy
-- for receipt-images only.

DROP POLICY IF EXISTS "Users can delete own receipts" ON public.receipts;
DROP POLICY IF EXISTS "Group members can read receipt splits" ON public.receipt_splits;

DROP POLICY IF EXISTS zt_receipts_insert ON public.receipts;
CREATE POLICY zt_receipts_insert
  ON public.receipts
  FOR INSERT
  TO authenticated
  WITH CHECK (
    host_id = (SELECT auth.uid())
    AND (
      CASE
        WHEN group_id IS NULL THEN true
        ELSE public.is_group_member(group_id)
      END
    )
  );

DROP POLICY IF EXISTS zt_receipts_update ON public.receipts;
CREATE POLICY zt_receipts_update
  ON public.receipts
  FOR UPDATE
  TO authenticated
  USING (host_id = (SELECT auth.uid()))
  WITH CHECK (
    host_id = (SELECT auth.uid())
    AND (
      CASE
        WHEN group_id IS NULL THEN true
        ELSE public.is_group_member(group_id)
      END
    )
  );

DROP POLICY IF EXISTS zt_items_insert ON public.items;
CREATE POLICY zt_items_insert
  ON public.items
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_receipt_host(receipt_id));

DROP POLICY IF EXISTS receipt_images_buckets_select ON storage.buckets;
CREATE POLICY receipt_images_buckets_select
  ON storage.buckets
  FOR SELECT
  TO authenticated
  USING (id = 'receipt-images');

GRANT ALL ON TABLE public.receipt_scan_rate_limits TO service_role;
GRANT ALL ON TABLE public.receipt_scan_audit_logs TO service_role;
GRANT EXECUTE ON FUNCTION public.check_and_increment_scan_quota(uuid, integer, integer) TO service_role;
