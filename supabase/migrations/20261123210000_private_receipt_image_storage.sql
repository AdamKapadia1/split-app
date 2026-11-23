-- Private receipt photos. The bucket is not public. Object names are
-- `<auth uid>/<receipt uuid>.jpg`. Reads go through a security-definer helper
-- so storage policies never re-enter receipts RLS (no recursion). The helper
-- reads public tables as the function owner and never selects storage.objects.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'receipt-images',
  'receipt-images',
  false,
  5242880,
  ARRAY['image/jpeg', 'image/webp', 'image/png']::text[]
)
ON CONFLICT (id) DO UPDATE
SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

ALTER TABLE public.receipts
  ADD COLUMN IF NOT EXISTS image_path TEXT;

ALTER TABLE public.receipts
  DROP CONSTRAINT IF EXISTS receipts_image_path_format;

ALTER TABLE public.receipts
  ADD CONSTRAINT receipts_image_path_format
  CHECK (image_path IS NULL OR image_path ~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.jpg$');

CREATE INDEX IF NOT EXISTS receipts_image_path_not_null_idx
  ON public.receipts (image_path)
  WHERE image_path IS NOT NULL;

CREATE OR REPLACE FUNCTION public.can_access_receipt_image(object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    auth.uid() IS NOT NULL
    AND object_name IS NOT NULL
    AND (
      (storage.foldername(object_name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1
        FROM public.receipts AS r
        WHERE r.image_path = object_name
          AND (
            r.host_id = auth.uid()
            OR EXISTS (
              SELECT 1
              FROM public.splits AS s
              WHERE s.receipt_id = r.id
                AND s.user_id = auth.uid()
            )
            OR EXISTS (
              SELECT 1
              FROM public.receipt_splits AS rs
              WHERE rs.receipt_id = r.id
                AND rs.user_id = auth.uid()
            )
            OR (
              r.group_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM public.group_members AS gm
                WHERE gm.group_id = r.group_id
                  AND gm.user_id = auth.uid()
              )
            )
          )
      )
    );
$$;

REVOKE ALL ON FUNCTION public.can_access_receipt_image(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_receipt_image(text) TO authenticated;

DROP POLICY IF EXISTS receipt_images_objects_insert ON storage.objects;
CREATE POLICY receipt_images_objects_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'receipt-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS receipt_images_objects_update ON storage.objects;
CREATE POLICY receipt_images_objects_update
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'receipt-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'receipt-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS receipt_images_objects_select ON storage.objects;
CREATE POLICY receipt_images_objects_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'receipt-images'
    AND public.can_access_receipt_image(name)
  );

DROP POLICY IF EXISTS receipt_images_objects_delete ON storage.objects;
CREATE POLICY receipt_images_objects_delete
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'receipt-images'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
