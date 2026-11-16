CREATE TABLE "overlays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_table" text NOT NULL,
	"target_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" real NOT NULL,
	"reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_because" text,
	"ended_detail" jsonb,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_overlays_kind" CHECK (("overlays"."kind" IN ('importance', 'contestation') AND "overlays"."target_table" = 'claims')
          OR ("overlays"."kind" = 'set_aside' AND "overlays"."target_table" IN ('claim_relationships', 'arguments'))),
	CONSTRAINT "ck_overlays_value" CHECK ("overlays"."value" >= 0 AND "overlays"."value" <= 1
          AND ("overlays"."kind" <> 'set_aside' OR ("overlays"."value" IN (0, 1) AND ("overlays"."value" = 0 OR "overlays"."reason" IS NOT NULL)))),
	CONSTRAINT "ck_overlays_ended" CHECK ("overlays"."ended_because" IS NULL OR "overlays"."ended_because" IN ('taken_back', 'replaced', 'removed_below', 'retyped_below', 'retired_below', 'merged_below', 'withdrawn_below'))
);
--> statement-breakpoint
ALTER TABLE "overlays" ADD CONSTRAINT "overlays_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_overlays_live" ON "overlays" USING btree ("target_table","target_id","kind","sensitivity_label") WHERE "overlays"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_overlays_claim" ON "overlays" USING btree ("claim_id","sensitivity_label");--> statement-breakpoint
CREATE INDEX "idx_overlays_target" ON "overlays" USING btree ("target_id","kind");
--> statement-breakpoint
-- An overlay follows the row below it. When the layer below removes or
-- retypes an edge, retires or removes an argument, or merges or withdraws
-- a node, what a label above held over that row no longer has the thing it
-- was said of: it is ended here, in the transaction that changed the row,
-- with what the layer below did. Nothing else is changed above, and the
-- Steward at the overlay's label is told on its next pass
-- (llm/agents/changes-below-note.ts), from the ended row itself.
--
-- It runs with its owner's rights because the work that changes the row
-- below does not read the labels above it, and must not learn from the
-- outcome whether one of them held anything. It does nothing while
-- 'public' is the only label.
CREATE OR REPLACE FUNCTION minerval_overlay_follows_below() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  why text;
  said jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.labels l WHERE l.name <> 'public') THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'claim_relationships' THEN
    IF TG_OP = 'UPDATE' AND NEW.relation_type IS NOT DISTINCT FROM OLD.relation_type THEN
      -- The edge moved with its node (a merge): the overlay stays on it.
      IF NEW.parent_claim_id IS DISTINCT FROM OLD.parent_claim_id THEN
        UPDATE public.overlays SET claim_id = NEW.parent_claim_id
         WHERE target_table = 'claim_relationships' AND target_id = NEW.id;
      END IF;
      RETURN NULL;
    END IF;
    why := CASE WHEN TG_OP = 'DELETE' THEN 'removed_below' ELSE 'retyped_below' END;
    said := jsonb_build_object('edge_id', OLD.id, 'child_claim_id', OLD.child_claim_id, 'relation_type', OLD.relation_type);
    IF TG_OP = 'UPDATE' THEN
      said := said || jsonb_build_object('now', NEW.relation_type);
    END IF;
    UPDATE public.overlays SET ended_at = now(), ended_because = why, ended_detail = said
     WHERE target_table = 'claim_relationships' AND target_id = OLD.id AND ended_at IS NULL;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'arguments' THEN
    IF TG_OP = 'UPDATE' AND NEW.claim_id IS DISTINCT FROM OLD.claim_id THEN
      UPDATE public.overlays SET claim_id = NEW.claim_id WHERE target_table = 'arguments' AND target_id = NEW.id;
    END IF;
    IF TG_OP = 'DELETE' OR (NEW.retired_at IS NOT NULL AND OLD.retired_at IS NULL) THEN
      said := jsonb_build_object('argument_id', OLD.id, 'name', OLD.name);
      IF TG_OP = 'UPDATE' AND NEW.retired_reason IS NOT NULL THEN
        said := said || jsonb_build_object('reason', NEW.retired_reason);
      END IF;
      UPDATE public.overlays
         SET ended_at = now(), ended_because = CASE WHEN TG_OP = 'DELETE' THEN 'removed_below' ELSE 'retired_below' END, ended_detail = said
       WHERE target_table = 'arguments' AND target_id = OLD.id AND ended_at IS NULL;
    END IF;
    RETURN NULL;
  END IF;
  -- A node that is no longer active.
  IF NEW.state IS DISTINCT FROM OLD.state AND OLD.state = 'active' THEN
    UPDATE public.overlays
       SET ended_at = now(),
           ended_because = CASE WHEN NEW.state = 'merged' THEN 'merged_below' ELSE 'withdrawn_below' END,
           ended_detail = CASE WHEN NEW.state = 'merged' THEN jsonb_build_object('merged_into', NEW.merged_into)
                               ELSE jsonb_build_object('state', NEW.state) END
     WHERE target_table = 'claims' AND target_id = NEW.id AND ended_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "overlay_follows_below" AFTER UPDATE OF "relation_type", "parent_claim_id" OR DELETE ON "claim_relationships" FOR EACH ROW EXECUTE FUNCTION minerval_overlay_follows_below();--> statement-breakpoint
CREATE TRIGGER "overlay_follows_below" AFTER UPDATE OF "retired_at", "claim_id" OR DELETE ON "arguments" FOR EACH ROW EXECUTE FUNCTION minerval_overlay_follows_below();--> statement-breakpoint
CREATE TRIGGER "overlay_follows_below" AFTER UPDATE OF "state" ON "claims" FOR EACH ROW EXECUTE FUNCTION minerval_overlay_follows_below();
--> statement-breakpoint
-- Where a deployment already has more than one label, the new table gets
-- its policies and guards as every labelled table has them.
SELECT public.minerval_enforcement_sync();
