-- History keyset pagination.
--
-- The History query reads public.receipts with no client equality filter.
-- Visibility stays in RLS (the owner is host_id, and group members can also
-- read a receipt). The client orders every page by created_at DESC, id DESC
-- and, for later pages, seeks with:
--   created_at < cursor OR (created_at = cursor AND id < cursor)
--
-- This index matches that sort and seek so Postgres can walk the newest rows
-- directly instead of sequentially scanning the ledger as receipt volume grows.
-- id is the tie-break: two receipts inserted in the same millisecond still
-- paginate in a stable order.

CREATE INDEX IF NOT EXISTS idx_receipts_history_keyset
  ON public.receipts (created_at DESC, id DESC);
