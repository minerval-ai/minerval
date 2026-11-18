ALTER TABLE "lookouts" ALTER COLUMN "grant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "lookouts" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "lookouts" ADD COLUMN "paused_for_fund" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lookouts" ADD CONSTRAINT "lookouts_node_id_claims_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_lookouts_node" ON "lookouts" USING btree ("node_id") WHERE node_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "lookouts" ADD CONSTRAINT "ck_lookouts_one_owner" CHECK (("lookouts"."grant_id" IS NULL) <> ("lookouts"."node_id" IS NULL));