-- The rule that a version on a node at another label rests on material at
-- the version's own label was tested when a current version was inserted,
-- and not when a row inserted as not current was made current afterwards,
-- which stored the version the rule refuses. It is now tested whenever a
-- version becomes current, by either statement.
--
-- A version whose material is taken away later is not this trigger's to
-- refuse: the statement that detaches a source is not a write of the
-- version. The upkeep of versions finds it and opens a reassessment at the
-- version's label (src/services/version-upkeep.ts).
--
-- The refusal no longer says which label the node carries. The writer may
-- not read that label, and the words are now the same for a node at a label
-- the writer does not read, a node that does not exist, and a node it reads
-- with nothing of its own on it, so the refusal tells none of them apart.
CREATE OR REPLACE FUNCTION minerval_judgment_label_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  own text := COALESCE(NULLIF(current_setting('minerval.label', true), ''), 'public');
  node_column text := TG_ARGV[0];
  node uuid;
  claim uuid;
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
      SELECT a.sensitivity_label, a.claim_id INTO node_label, claim FROM public.arguments a WHERE a.id = node;
    ELSE
      claim := node;
      SELECT c.sensitivity_label INTO node_label FROM public.claims c WHERE c.id = node;
    END IF;
    IF node_label IS DISTINCT FROM NEW.sensitivity_label
       AND NOT public.minerval_material_at(claim, NEW.sensitivity_label) THEN
      RAISE EXCEPTION 'this version was not recorded: nothing at the label "%" bears on the node', NEW.sensitivity_label
        USING ERRCODE = 'MVL07',
              HINT = 'A version on a node that does not carry the version''s own label rests on material at that label: a source at that label attached to the node, a node at that label under it, or a node under it with a version at that label. With none, the version this label reads stands for its readers. The same is said of a node this work does not read. Nothing was recorded.';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
