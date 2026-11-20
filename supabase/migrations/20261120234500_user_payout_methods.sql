-- Tier 1 UK payout methods.
--
-- One row per member. Handles and bank details are readable only by the owner
-- and by someone who already shares a group or a receipt split with them.
-- The audit log records which fields changed, never the values.

CREATE TABLE IF NOT EXISTS public.user_payout_methods (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  preferred_method text NULL CHECK (preferred_method IN ('monzo', 'revolut', 'paypal', 'bank')),
  monzo_handle text NULL CHECK (
    monzo_handle IS NULL
    OR (char_length(monzo_handle) BETWEEN 2 AND 64 AND monzo_handle ~ '^[A-Za-z0-9._-]+$')
  ),
  revolut_handle text NULL CHECK (
    revolut_handle IS NULL
    OR (char_length(revolut_handle) BETWEEN 2 AND 64 AND revolut_handle ~ '^[A-Za-z0-9._-]+$')
  ),
  paypal_handle text NULL CHECK (
    paypal_handle IS NULL
    OR (char_length(paypal_handle) BETWEEN 2 AND 64 AND paypal_handle ~ '^[A-Za-z0-9]+$')
  ),
  bank_account_name text NULL CHECK (
    bank_account_name IS NULL
    OR (char_length(trim(bank_account_name)) BETWEEN 2 AND 70)
  ),
  bank_sort_code text NULL CHECK (
    bank_sort_code IS NULL OR bank_sort_code ~ '^[0-9]{6}$'
  ),
  bank_account_number text NULL CHECK (
    bank_account_number IS NULL OR bank_account_number ~ '^[0-9]{8}$'
  ),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_payout_methods_bank_complete CHECK (
    (
      bank_account_name IS NULL
      AND bank_sort_code IS NULL
      AND bank_account_number IS NULL
    )
    OR (
      bank_account_name IS NOT NULL
      AND bank_sort_code IS NOT NULL
      AND bank_account_number IS NOT NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS public.payout_method_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  changed_fields text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payout_method_audit_user
  ON public.payout_method_audit_log (user_id, created_at DESC);

-- Field names only. A changed sort code is recorded as the name "bank_sort_code".
CREATE OR REPLACE FUNCTION public.log_payout_method_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cols text[] := ARRAY[
    'preferred_method',
    'monzo_handle',
    'revolut_handle',
    'paypal_handle',
    'bank_account_name',
    'bank_sort_code',
    'bank_account_number'
  ];
  fields text[] := ARRAY[]::text[];
  col text;
  old_value text;
  new_value text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOREACH col IN ARRAY cols LOOP
      new_value := to_jsonb(NEW) ->> col;
      IF new_value IS NOT NULL THEN
        fields := array_append(fields, col);
      END IF;
    END LOOP;
    INSERT INTO public.payout_method_audit_log (user_id, action, changed_fields)
    VALUES (NEW.user_id, 'INSERT', fields);
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    FOREACH col IN ARRAY cols LOOP
      old_value := to_jsonb(OLD) ->> col;
      IF old_value IS NOT NULL THEN
        fields := array_append(fields, col);
      END IF;
    END LOOP;
    INSERT INTO public.payout_method_audit_log (user_id, action, changed_fields)
    VALUES (OLD.user_id, 'DELETE', fields);
    RETURN OLD;
  END IF;

  FOREACH col IN ARRAY cols LOOP
    old_value := to_jsonb(OLD) ->> col;
    new_value := to_jsonb(NEW) ->> col;
    IF old_value IS DISTINCT FROM new_value THEN
      fields := array_append(fields, col);
    END IF;
  END LOOP;
  INSERT INTO public.payout_method_audit_log (user_id, action, changed_fields)
  VALUES (NEW.user_id, 'UPDATE', fields);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.log_payout_method_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS user_payout_methods_audit ON public.user_payout_methods;
CREATE TRIGGER user_payout_methods_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.user_payout_methods
  FOR EACH ROW
  EXECUTE FUNCTION public.log_payout_method_change();

ALTER TABLE public.user_payout_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_payout_methods FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payout_method_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_method_audit_log FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.user_payout_methods FROM anon, public, authenticated;
REVOKE ALL ON TABLE public.payout_method_audit_log FROM anon, public, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_payout_methods TO authenticated;
GRANT SELECT ON TABLE public.payout_method_audit_log TO authenticated;

DROP POLICY IF EXISTS user_payout_methods_owner_select ON public.user_payout_methods;
CREATE POLICY user_payout_methods_owner_select
  ON public.user_payout_methods
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS user_payout_methods_owner_insert ON public.user_payout_methods;
CREATE POLICY user_payout_methods_owner_insert
  ON public.user_payout_methods
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_payout_methods_owner_update ON public.user_payout_methods;
CREATE POLICY user_payout_methods_owner_update
  ON public.user_payout_methods
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS user_payout_methods_owner_delete ON public.user_payout_methods;
CREATE POLICY user_payout_methods_owner_delete
  ON public.user_payout_methods
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- A peer can read a payout row only when they already share a group or a receipt split.
DROP POLICY IF EXISTS user_payout_methods_peer_select ON public.user_payout_methods;
CREATE POLICY user_payout_methods_peer_select
  ON public.user_payout_methods
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IS NOT NULL
    AND auth.uid() <> user_id
    AND (
      EXISTS (
        SELECT 1
        FROM public.group_members mine
        JOIN public.group_members theirs ON theirs.group_id = mine.group_id
        WHERE mine.user_id = auth.uid()
          AND theirs.user_id = user_payout_methods.user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.receipts host_receipt
        JOIN public.receipt_splits peer_split ON peer_split.receipt_id = host_receipt.id
        WHERE host_receipt.host_id = auth.uid()
          AND peer_split.user_id = user_payout_methods.user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.receipts host_receipt
        JOIN public.receipt_splits mine ON mine.receipt_id = host_receipt.id
        WHERE host_receipt.host_id = user_payout_methods.user_id
          AND mine.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1
        FROM public.receipt_splits mine
        JOIN public.receipt_splits theirs ON theirs.receipt_id = mine.receipt_id
        WHERE mine.user_id = auth.uid()
          AND theirs.user_id = user_payout_methods.user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.splits mine
        JOIN public.splits theirs ON theirs.receipt_id = mine.receipt_id
        WHERE mine.user_id = auth.uid()
          AND theirs.user_id = user_payout_methods.user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.receipts paid
        JOIN public.receipt_splits owe ON owe.receipt_id = paid.id
        WHERE paid.paid_by = auth.uid()
          AND owe.user_id = user_payout_methods.user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.receipts paid
        JOIN public.receipt_splits owe ON owe.receipt_id = paid.id
        WHERE paid.paid_by = user_payout_methods.user_id
          AND owe.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS payout_method_audit_select_own ON public.payout_method_audit_log;
CREATE POLICY payout_method_audit_select_own
  ON public.payout_method_audit_log
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
