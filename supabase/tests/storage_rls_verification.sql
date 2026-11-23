-- Repeatable, read-only check for the private receipt-images bucket.
-- Confirms the bucket is private, the four authenticated object policies exist,
-- and anon cannot execute the helper or match a receipt-images policy.
-- Rolls back so this file cannot persist writes.
-- Run after 20261123210000_private_receipt_image_storage.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/storage_rls_verification.sql

BEGIN;

DO $$
DECLARE
  v_public boolean;
  v_limit bigint;
  v_mimes text[];
  v_policies integer;
  v_missing text;
  v_anon_policies text;
  v_anon_execute boolean;
  v_public_execute boolean;
  v_auth_execute boolean;
  v_definer boolean;
BEGIN
  SELECT b.public, b.file_size_limit, b.allowed_mime_types
  INTO v_public, v_limit, v_mimes
  FROM storage.buckets AS b
  WHERE b.id = 'receipt-images';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'receipt-images bucket is missing';
  END IF;

  IF v_public IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'receipt-images bucket is public';
  END IF;

  IF v_limit IS DISTINCT FROM 5242880 THEN
    RAISE EXCEPTION 'receipt-images file_size_limit is %, expected 5242880', v_limit;
  END IF;

  IF v_mimes IS NULL
    OR cardinality(v_mimes) <> 3
    OR NOT ('image/jpeg' = ANY (v_mimes))
    OR NOT ('image/webp' = ANY (v_mimes))
    OR NOT ('image/png' = ANY (v_mimes))
  THEN
    RAISE EXCEPTION 'receipt-images allowed_mime_types must be jpeg, webp, and png only';
  END IF;

  SELECT count(*)
  INTO v_policies
  FROM pg_policies
  WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND policyname IN (
      'receipt_images_objects_insert',
      'receipt_images_objects_update',
      'receipt_images_objects_select',
      'receipt_images_objects_delete'
    )
    AND 'authenticated' = ANY (roles);

  IF v_policies <> 4 THEN
    RAISE EXCEPTION 'expected 4 authenticated receipt image policies, found %', v_policies;
  END IF;

  SELECT string_agg(policyname, ', ' ORDER BY policyname)
  INTO v_missing
  FROM (
    VALUES
      ('receipt_images_objects_insert', 'INSERT'),
      ('receipt_images_objects_update', 'UPDATE'),
      ('receipt_images_objects_select', 'SELECT'),
      ('receipt_images_objects_delete', 'DELETE')
  ) AS expected(policyname, cmd)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies AS p
    WHERE p.schemaname = 'storage'
      AND p.tablename = 'objects'
      AND p.policyname = expected.policyname
      AND p.cmd = expected.cmd
      AND 'authenticated' = ANY (p.roles)
      AND (
        COALESCE(p.qual, '') ILIKE '%receipt-images%'
        OR COALESCE(p.with_check, '') ILIKE '%receipt-images%'
      )
  );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'receipt image policies failed shape check: %', v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'receipt_images_objects_select'
      AND qual ILIKE '%can_access_receipt_image%'
  ) THEN
    RAISE EXCEPTION 'select policy does not use can_access_receipt_image';
  END IF;

  SELECT string_agg(policyname, ', ' ORDER BY policyname)
  INTO v_anon_policies
  FROM pg_policies
  WHERE schemaname = 'storage'
    AND tablename = 'objects'
    AND (
      COALESCE(qual, '') ILIKE '%receipt-images%'
      OR COALESCE(with_check, '') ILIKE '%receipt-images%'
    )
    AND (
      'anon' = ANY (roles)
      OR 'public' = ANY (roles)
    );

  IF v_anon_policies IS NOT NULL THEN
    RAISE EXCEPTION 'anon or public can access receipt-images via %', v_anon_policies;
  END IF;

  IF to_regprocedure('public.can_access_receipt_image(text)') IS NULL THEN
    RAISE EXCEPTION 'public.can_access_receipt_image(text) is missing';
  END IF;

  SELECT p.prosecdef
  INTO v_definer
  FROM pg_proc AS p
  JOIN pg_namespace AS n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'can_access_receipt_image';

  IF v_definer IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'can_access_receipt_image must be security definer';
  END IF;

  v_anon_execute := has_function_privilege('anon', 'public.can_access_receipt_image(text)', 'EXECUTE');
  v_public_execute := has_function_privilege('public', 'public.can_access_receipt_image(text)', 'EXECUTE');
  v_auth_execute := has_function_privilege('authenticated', 'public.can_access_receipt_image(text)', 'EXECUTE');

  IF v_anon_execute OR v_public_execute THEN
    RAISE EXCEPTION 'anon or public can execute can_access_receipt_image';
  END IF;

  IF NOT v_auth_execute THEN
    RAISE EXCEPTION 'authenticated cannot execute can_access_receipt_image';
  END IF;

  RAISE NOTICE 'receipt image storage verification passed';
END $$;

ROLLBACK;
