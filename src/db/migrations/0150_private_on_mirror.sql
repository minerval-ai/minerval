-- A deployment's own rows beside the public graph's (docs/mirror.md,
-- "Beside a deployment's own rows").
--
-- 1. Identity is per graph. Each key a replicated table has besides its id
--    gains `origin` as its last column: a source's address, an edge's two
--    nodes and relation, a lateral link's pair and kind, a question's pair
--    of answers, a document's segment order, and an argument's grouping of
--    an edge. A row this deployment made and the mirrored row for the same
--    thing no longer collide, so a batch of the mirror is never refused
--    because of a row of the deployment's own. Every row on the public
--    graph is 'local', so there each index holds what it held; it is
--    rebuilt once, here.
-- 2. mirror_node_changes: what each applied batch changed on a mirrored
--    node that a judgment's own record of its inputs cannot show (a
--    wording, an argument, a merge, a withdrawal). Empty on a deployment
--    that does not mirror.
CREATE TABLE "mirror_node_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"cut_at" timestamp with time zone NOT NULL,
	"change" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_mirror_node_changes_change" CHECK ("mirror_node_changes"."change" IN ('reworded', 'argument_added', 'argument_rewritten', 'argument_retired', 'argument_removed', 'merged', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "sources" DROP CONSTRAINT "sources_url_unique";--> statement-breakpoint
DROP INDEX "idx_answer_relations_pair";--> statement-breakpoint
DROP INDEX "idx_claim_links_unique";--> statement-breakpoint
DROP INDEX "idx_cr_unique";--> statement-breakpoint
DROP INDEX "idx_source_segments_order";--> statement-breakpoint
ALTER TABLE "argument_subclaims" DROP CONSTRAINT "argument_subclaims_argument_id_relationship_id_pk";--> statement-breakpoint
ALTER TABLE "argument_subclaims" ADD CONSTRAINT "argument_subclaims_argument_id_relationship_id_origin_pk" PRIMARY KEY("argument_id","relationship_id","origin");--> statement-breakpoint
ALTER TABLE "mirror_node_changes" ADD CONSTRAINT "mirror_node_changes_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mirror_node_changes_claim" ON "mirror_node_changes" USING btree ("claim_id","applied_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sources_url_origin" ON "sources" USING btree ("url","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_answer_relations_pair" ON "answer_relations" USING btree ("question_id","claim_a_id","claim_b_id","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_claim_links_unique" ON "claim_links" USING btree ("claim_a_id","claim_b_id","kind","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cr_unique" ON "claim_relationships" USING btree ("parent_claim_id","child_claim_id","relation_type","origin");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_segments_order" ON "source_segments" USING btree ("source_id","ordinal","origin");--> statement-breakpoint
-- On a database that already has a second label: the new table is covered
-- by the policies, and the guard against unseen collisions is rebuilt on
-- the keys as they now are. On the public graph the step finds one label
-- and changes nothing.
SELECT public.minerval_enforcement_sync();
