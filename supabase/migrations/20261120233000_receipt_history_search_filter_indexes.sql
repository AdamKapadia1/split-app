-- History search and group-chip indexes.
--
-- Receipt history is still a keyset walk:
--   ORDER BY created_at DESC, id DESC
--   created_at < cursor OR (created_at = cursor AND id < cursor)
-- Search and group chips add equality / pattern filters in front of that seek.
-- Visibility stays in RLS. These indexes only match the filter + sort shape.

-- pg_trgm supplies gin_trgm_ops, which can satisfy
--   WHERE merchant_name ILIKE '%term%'
-- A leading wildcard would otherwise force a sequential scan of the ledger.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Case-insensitive substring search on the merchant / store name.
-- Query: merchant_name ILIKE '%' || escaped_term || '%'
CREATE INDEX IF NOT EXISTS idx_receipts_merchant_trgm
  ON public.receipts USING gin (merchant_name gin_trgm_ops);

-- Group chip + keyset pagination.
-- Query:
--   WHERE group_id = $uuid
--     AND (created_at < cursor OR (created_at = cursor AND id < cursor))
--   ORDER BY created_at DESC, id DESC
-- group_id leads so one group is walked newest-first. id is the tie-break.
CREATE INDEX IF NOT EXISTS idx_receipts_group_history_keyset
  ON public.receipts (group_id, created_at DESC, id DESC)
  WHERE group_id IS NOT NULL;

-- Personal / ungrouped chip + the same keyset.
-- Query:
--   WHERE group_id IS NULL
--     AND (created_at < cursor OR (created_at = cursor AND id < cursor))
--   ORDER BY created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_receipts_ungrouped_history_keyset
  ON public.receipts (created_at DESC, id DESC)
  WHERE group_id IS NULL;

ANALYZE public.receipts;
