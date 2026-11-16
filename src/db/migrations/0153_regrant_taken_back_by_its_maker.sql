-- The own-label guard let every DELETE of a regrant through, at any label,
-- for one case: a mandate that takes back a regrant it made, whole, before
-- anything has come back from it (withdrawFromMandate). The row may be at
-- another label than the work that takes it back, and the money view it is
-- deleted through reads every label, so as written a cleared connection
-- could delete any regrant between any two mandates.
--
-- It now lets through that case and no other: nothing has been returned
-- from the regrant, and the mandate that made it is at the label of the
-- work deleting it. Whether the mandate is at that label is read on the
-- writer's own connection, so a mandate it does not read never qualifies.
-- The refusal names no label: through the money view the writer may be
-- refused over a row at a label it does not read.
CREATE OR REPLACE FUNCTION minerval_own_label_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF session_user <> 'minerval_cleared'
     OR OLD.sensitivity_label = public.minerval_write_label()
     OR pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_TABLE_NAME = 'action_allocations' AND TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - 'amount_micro_usd' - 'spent_micro_usd' - 'released_at')
       = (to_jsonb(NEW) - 'amount_micro_usd' - 'spent_micro_usd' - 'released_at') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'regrants' THEN
    IF TG_OP = 'DELETE' THEN
      IF OLD.refunded_micro_usd = 0
         AND EXISTS (SELECT 1 FROM public.grants g
                      WHERE g.id = OLD.from_grant_id
                        AND g.sensitivity_label = public.minerval_write_label()) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'this regrant was not deleted: a regrant is taken back whole only by the mandate that made it, by work at that mandate''s label, and only while nothing has been returned from it'
        USING ERRCODE = 'MVL06',
              TABLE = TG_TABLE_NAME,
              HINT = 'Work changes and deletes only rows at its own label. Settling money lowers a regrant''s amount; the row itself goes only when its maker takes all of it back. Nothing was changed.';
    END IF;
    IF (to_jsonb(OLD) - 'amount_micro_usd' - 'refunded_micro_usd')
       = (to_jsonb(NEW) - 'amount_micro_usd' - 'refunded_micro_usd') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'this was not changed: the row is at the label "%" and this work is at "%"',
      OLD.sensitivity_label, public.minerval_write_label()
    USING ERRCODE = 'MVL06',
          TABLE = TG_TABLE_NAME,
          HINT = 'Work changes and deletes only rows at its own label. What another label holds is that label''s to change: record what this label has to say as a row of its own. Nothing was changed.';
END
$$;
