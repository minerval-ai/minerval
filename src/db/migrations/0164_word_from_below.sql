-- Word from the layer below (docs/architecture.md). Three things:
--   1. mirror_node_changes becomes node_changes: what the layer below changed
--      on a node, whether the layer below is the public graph (written by the
--      mirror's applier, with the batch) or a label of this deployment
--      (written by the trigger at the end of this file, with no batch).
--   2. node_message_reads: a message read, and answered, at a label above the
--      one it was sent at, without a write to the message.
--   3. adopted_requests links a request to the one it was taken up from at
--      any layer below: the public graph's (public_request_id) or a label
--      this row's label reads (from_request_id).
ALTER TABLE "mirror_node_changes" DROP CONSTRAINT "ck_mirror_node_changes_change";--> statement-breakpoint
ALTER TABLE "mirror_node_changes" RENAME TO "node_changes";--> statement-breakpoint
ALTER TABLE "node_changes" DROP CONSTRAINT "mirror_node_changes_sensitivity_label_labels_name_fk";
--> statement-breakpoint
ALTER TABLE "node_changes" ADD CONSTRAINT "node_changes_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "node_message_reads" (
	"message_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text,
	"outcome_note" text,
	"answered_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "node_message_reads_message_id_sensitivity_label_pk" PRIMARY KEY("message_id","sensitivity_label"),
	CONSTRAINT "ck_node_message_reads_outcome" CHECK ("node_message_reads"."outcome" IS NULL OR "node_message_reads"."outcome" IN ('changed', 'no_change', 'disagree'))
);
--> statement-breakpoint
DROP INDEX "idx_mirror_node_changes_claim";--> statement-breakpoint
ALTER TABLE "adopted_requests" ALTER COLUMN "public_request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "node_changes" ALTER COLUMN "sequence" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "node_changes" ALTER COLUMN "cut_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "adopted_requests" ADD COLUMN "from_request_id" uuid;--> statement-breakpoint
ALTER TABLE "node_message_reads" ADD CONSTRAINT "node_message_reads_message_id_node_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."node_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_message_reads" ADD CONSTRAINT "node_message_reads_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adopted_requests" ADD CONSTRAINT "adopted_requests_from_request_id_requests_id_fk" FOREIGN KEY ("from_request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_adopted_requests_from" ON "adopted_requests" USING btree ("from_request_id");--> statement-breakpoint
CREATE INDEX "idx_node_changes_claim" ON "node_changes" USING btree ("claim_id","applied_at");--> statement-breakpoint
ALTER TABLE "adopted_requests" ADD CONSTRAINT "ck_adopted_requests_from" CHECK (("adopted_requests"."public_request_id" IS NULL) <> ("adopted_requests"."from_request_id" IS NULL));--> statement-breakpoint
ALTER TABLE "node_changes" ADD CONSTRAINT "ck_node_changes_change" CHECK ("node_changes"."change" IN ('reworded', 'argument_added', 'argument_rewritten', 'argument_retired', 'argument_removed', 'kind_corrected', 'merged', 'withdrawn'));--> statement-breakpoint
-- What a deployment's own work changes on a node, written for the layer
-- above it. The mirror's applier writes the same rows for a node the public
-- graph holds, so a mirrored row is left to it. The row is derived from the
-- node's (or the argument's) row alone, the same whoever made the change,
-- so it carries that row's label and not the connection's (src/labels.ts).
-- Nothing is written while `public` is the only label: there is then no
-- layer above to tell, and the public graph keeps no such rows. A row that
-- goes because the row it hangs from went (a node deleted with its
-- arguments) is not a change anyone made to the node, and is not written.
CREATE OR REPLACE FUNCTION minerval_note_node_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r record := COALESCE(NEW, OLD);
  node uuid;
  what text;
  said jsonb;
BEGIN
  IF r.origin = 'mirror'
     OR pg_trigger_depth() > 1
     OR NOT EXISTS (SELECT 1 FROM public.labels l WHERE l.name <> 'public') THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'claims' THEN
    node := NEW.id;
    IF NEW.text IS DISTINCT FROM OLD.text THEN
      INSERT INTO public.node_changes (claim_id, change, detail, sensitivity_label)
      VALUES (node, 'reworded', jsonb_build_object('was', OLD.text, 'now', NEW.text), NEW.sensitivity_label);
    END IF;
    IF NEW.kind IS DISTINCT FROM OLD.kind THEN
      INSERT INTO public.node_changes (claim_id, change, detail, sensitivity_label)
      VALUES (node, 'kind_corrected', jsonb_build_object('was', OLD.kind, 'now', NEW.kind), NEW.sensitivity_label);
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND OLD.state = 'active' THEN
      IF NEW.state = 'merged' THEN
        INSERT INTO public.node_changes (claim_id, change, detail, sensitivity_label)
        VALUES (node, 'merged', jsonb_build_object('merged_into', NEW.merged_into), NEW.sensitivity_label);
      ELSE
        INSERT INTO public.node_changes (claim_id, change, detail, sensitivity_label)
        VALUES (node, 'withdrawn', jsonb_build_object('how', 'state', 'state', NEW.state), NEW.sensitivity_label);
      END IF;
    END IF;
    RETURN NULL;
  END IF;
  -- An argument.
  node := r.claim_id;
  IF TG_OP = 'INSERT' THEN
    what := 'argument_added';
  ELSIF TG_OP = 'DELETE' THEN
    what := 'argument_removed';
  ELSIF NEW.retired_at IS NOT NULL AND OLD.retired_at IS NULL THEN
    what := 'argument_retired';
  ELSIF (NEW.name, NEW.description, NEW.stance, NEW.content, NEW.shows)
        IS DISTINCT FROM (OLD.name, OLD.description, OLD.stance, OLD.content, OLD.shows) THEN
    what := 'argument_rewritten';
  ELSE
    RETURN NULL;
  END IF;
  said := jsonb_build_object('argument_id', r.id, 'name', r.name);
  IF what = 'argument_retired' AND NEW.retired_reason IS NOT NULL THEN
    said := said || jsonb_build_object('reason', NEW.retired_reason);
  END IF;
  INSERT INTO public.node_changes (claim_id, change, detail, sensitivity_label)
  VALUES (node, what, said, r.sensitivity_label);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "note_node_change" AFTER UPDATE OF "text", "kind", "state" ON "claims" FOR EACH ROW EXECUTE FUNCTION minerval_note_node_change();--> statement-breakpoint
CREATE TRIGGER "note_node_change" AFTER INSERT OR UPDATE OR DELETE ON "arguments" FOR EACH ROW EXECUTE FUNCTION minerval_note_node_change();
