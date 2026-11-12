CREATE TABLE "stated_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contribution_id" uuid NOT NULL,
	"instance_id" uuid,
	"stance" text NOT NULL,
	"stated_probability" real,
	"stated_estimate" jsonb,
	"statement" text NOT NULL,
	"reasons" text,
	"stake" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_stated_views_probability" CHECK ("stated_views"."stated_probability" IS NULL OR ("stated_views"."stated_probability" >= 0 AND "stated_views"."stated_probability" <= 1))
);
--> statement-breakpoint
ALTER TABLE "stated_views" ADD CONSTRAINT "stated_views_contribution_id_contributions_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contributions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stated_views" ADD CONSTRAINT "stated_views_instance_id_claim_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."claim_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_stated_views_contribution" ON "stated_views" USING btree ("contribution_id");--> statement-breakpoint
CREATE INDEX "idx_stated_views_instance" ON "stated_views" USING btree ("instance_id");