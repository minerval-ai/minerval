-- A judgment at a label on a node that carries another label is no longer
-- refused for want of material at that label attached to the node. Whether
-- what a label has bears on a node is a judgment, and most of what a label
-- has is never a row here: it is read through a connection or a set of
-- files during the run. So the Steward at a label looks, and then records
-- its own judgment or leaves the one it reads standing.
--
-- Leaving it standing is recorded: an entry in audit_log with the action
-- 'left_standing', the run that made it (the new column), and in
-- judgment_inputs the judgments it left standing, as 'beside' rows of the
-- new kind 'left_standing' whose judgment_id is the entry's id
-- (src/services/left-standing-service.ts).
ALTER TABLE "judgment_inputs" DROP CONSTRAINT "ck_judgment_inputs_judgment_kind";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD CONSTRAINT "ck_judgment_inputs_judgment_kind" CHECK ("judgment_inputs"."judgment_kind" IN ('assessment', 'quantity_estimate', 'question_assessment', 'argument_evaluation', 'left_standing'));--> statement-breakpoint
-- Each label's own version. On a cleared connection a version is retired,
-- or brought back, only by work at its own label, as before. A version is
-- recorded on a node at the version's own label or at a label it reads, and
-- on no other: a run cannot see a node its label does not read, so it has
-- nothing to judge there, and the refusal is in the same words for a node
-- it does not read and a node that does not exist, so that it tells the
-- two apart for nobody. The test that something at the version's label was
-- attached to the node is gone.
CREATE OR REPLACE FUNCTION minerval_judgment_label_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  own text := COALESCE(NULLIF(current_setting('minerval.label', true), ''), 'public');
  node_column text := TG_ARGV[0];
  node uuid;
  node_label text;
BEGIN
  IF session_user <> 'minerval_cleared' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_current IS DISTINCT FROM NEW.is_current AND OLD.sensitivity_label <> own THEN
      RAISE EXCEPTION 'this version of the node''s judgment was recorded at another label, and this work may neither retire it nor bring it back'
        USING ERRCODE = 'MVL02',
              HINT = 'Each label keeps its own version of a node''s judgment, and a version is replaced only by work at its own label. Nothing was changed.';
    END IF;
    IF NOT (NEW.is_current AND NOT OLD.is_current) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.is_current THEN
    EXECUTE format('SELECT ($1).%I', node_column) INTO node USING NEW;
    IF TG_TABLE_NAME = 'argument_evaluations' THEN
      SELECT a.sensitivity_label INTO node_label FROM public.arguments a WHERE a.id = node;
    ELSE
      SELECT c.sensitivity_label INTO node_label FROM public.claims c WHERE c.id = node;
    END IF;
    IF node_label IS DISTINCT FROM NEW.sensitivity_label
       AND (node_label IS NULL
            OR NOT (node_label = ANY (public.minerval_labels_readable_from(ARRAY[NEW.sensitivity_label])))) THEN
      RAISE EXCEPTION 'this version was not recorded: the label "%" does not read this node', NEW.sensitivity_label
        USING ERRCODE = 'MVL07',
              HINT = 'A version of a node''s judgment is recorded at the node''s own label or at a label that reads it. The same is said of a node that does not exist. Nothing was recorded.';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS minerval_material_at(uuid, text);
