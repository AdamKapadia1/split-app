-- Delete and leave a group through locked-down RPCs.
-- Nullable foreign keys to public.groups (receipts) are rewritten to ON DELETE SET NULL
-- so a group delete cannot fail a constraint and does not destroy the payer's receipt.
-- NOT NULL foreign keys (group_members, settlements, invites) stay ON DELETE CASCADE.
-- public.groups.created_by is the delete authority. If that column is absent, role = 'owner'
-- is the fallback. Membership alone is never enough to delete.

DO $$
DECLARE
  r record;
  v_action text;
  v_current text;
BEGIN
  FOR r IN
    SELECT
      c.conname,
      n.nspname AS child_schema,
      cl.relname AS child_table,
      a.attname AS child_column,
      a.attnotnull AS not_null,
      pg_get_constraintdef(c.oid) AS definition,
      cardinality(c.conkey) AS key_count
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confrelid = 'public.groups'::regclass
  LOOP
    IF r.key_count <> 1 THEN
      RAISE EXCEPTION
        'Cannot safely rewrite multi-column foreign key %.% (%)',
        r.child_schema, r.child_table, r.conname;
    END IF;

    v_action := CASE WHEN r.not_null THEN 'CASCADE' ELSE 'SET NULL' END;
    v_current := upper(r.definition);

    IF v_action = 'CASCADE' AND v_current LIKE '%ON DELETE CASCADE%' THEN
      CONTINUE;
    END IF;

    IF v_action = 'SET NULL' AND v_current LIKE '%ON DELETE SET NULL%' THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I.%I DROP CONSTRAINT %I',
      r.child_schema,
      r.child_table,
      r.conname
    );

    EXECUTE format(
      'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.groups (id) ON DELETE %s',
      r.child_schema,
      r.child_table,
      r.conname,
      r.child_column,
      v_action
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.delete_group(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid;
  v_has_created_by boolean;
  v_creator uuid;
  v_is_owner boolean;
BEGIN
  v_actor := (SELECT auth.uid());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'Group not found';
  END IF;

  PERFORM 1
  FROM public.groups
  WHERE id = p_group_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Group not found';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'groups'
      AND column_name = 'created_by'
  )
  INTO v_has_created_by;

  IF v_has_created_by THEN
    EXECUTE 'SELECT created_by FROM public.groups WHERE id = $1'
      INTO v_creator
      USING p_group_id;

    IF v_creator IS NOT NULL AND v_creator IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Forbidden: only the group creator can delete this group';
    END IF;

    IF v_creator IS NOT NULL THEN
      DELETE FROM public.groups WHERE id = p_group_id;
      RETURN;
    END IF;
  END IF;

  -- created_by is missing or null on this row: only an owner may delete.
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND gm.user_id = v_actor
      AND gm.role = 'owner'
  )
  INTO v_is_owner;

  IF NOT COALESCE(v_is_owner, false) THEN
    RAISE EXCEPTION 'Forbidden: only the group creator can delete this group';
  END IF;

  DELETE FROM public.groups WHERE id = p_group_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_group(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_group(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.leave_group(p_group_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid;
  v_removed uuid;
BEGIN
  v_actor := (SELECT auth.uid());
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'Group not found';
  END IF;

  DELETE FROM public.group_members
  WHERE group_id = p_group_id
    AND user_id = v_actor
  RETURNING user_id INTO v_removed;

  IF v_removed IS NULL THEN
    RAISE EXCEPTION 'Forbidden: you are not a member of this group';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.leave_group(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leave_group(uuid) TO authenticated;
