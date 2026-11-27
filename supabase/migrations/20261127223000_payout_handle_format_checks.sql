-- Exact-amount payout handles.
-- user_payout_methods already stores monzo_handle and revolut_handle.
-- This migration only adds the columns when they are missing and attaches
-- named, idempotent CHECK constraints. Bank columns stay nullable so a host
-- can save Monzo only, Revolut only, bank only, or any combination.
-- Guest payout is not snapshotted on receipts. get_shared_bill reads the
-- host row for the share token at request time.

DO $$
BEGIN
  IF to_regclass('public.user_payout_methods') IS NULL THEN
    RAISE EXCEPTION 'public.user_payout_methods is required';
  END IF;
END $$;

ALTER TABLE public.user_payout_methods
  ADD COLUMN IF NOT EXISTS monzo_handle text,
  ADD COLUMN IF NOT EXISTS revolut_handle text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_payout_methods_monzo_handle_format'
      AND conrelid = 'public.user_payout_methods'::regclass
  ) THEN
    ALTER TABLE public.user_payout_methods
      ADD CONSTRAINT user_payout_methods_monzo_handle_format
      CHECK (monzo_handle IS NULL OR monzo_handle ~ '^[A-Za-z0-9._-]{2,64}$');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_payout_methods_revolut_handle_format'
      AND conrelid = 'public.user_payout_methods'::regclass
  ) THEN
    ALTER TABLE public.user_payout_methods
      ADD CONSTRAINT user_payout_methods_revolut_handle_format
      CHECK (revolut_handle IS NULL OR revolut_handle ~ '^[A-Za-z0-9._-]{2,64}$');
  END IF;
END $$;

-- The live guest RPC must keep returning these rails and must not grow
-- host email, phone, or auth metadata. Defined in 20261126150000.
DO $$
DECLARE
  v_def text;
BEGIN
  IF to_regprocedure('public.get_shared_bill(text)') IS NULL THEN
    RAISE EXCEPTION 'get_shared_bill(text) is required for the public split payout contract';
  END IF;

  v_def := pg_get_functiondef('public.get_shared_bill(text)'::regprocedure);

  IF position('''monzo_handle''' IN v_def) = 0
    OR position('''revolut_handle''' IN v_def) = 0
    OR position('''bank_account_name''' IN v_def) = 0
    OR position('''bank_sort_code''' IN v_def) = 0
    OR position('''bank_account_number''' IN v_def) = 0
  THEN
    RAISE EXCEPTION 'get_shared_bill must return monzo, revolut, and UK bank payout fields';
  END IF;

  IF v_def ~* '''(email|phone|phone_number)''' THEN
    RAISE EXCEPTION 'get_shared_bill must not expose host email or phone';
  END IF;
END $$;
