CREATE TABLE "consistency_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sweep_id" uuid,
	"kind" text NOT NULL,
	"primary_claim_id" uuid NOT NULL,
	"claim_ids" uuid[] NOT NULL,
	"action_id" uuid,
	"rationale" text NOT NULL,
	"expected_gain" real NOT NULL,
	"status_at_flag" text,
	"credence_at_flag" real,
	"assessment_id_at_flag" uuid,
	"repeats" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consistency_sweeps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_id" uuid,
	"partition" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"run_id" uuid,
	"claims_in_scope" integer DEFAULT 0 NOT NULL,
	"flags_raised" integer DEFAULT 0 NOT NULL,
	"note" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "ck_consistency_sweeps_partition" CHECK ("consistency_sweeps"."partition" IN ('tag', 'residual', 'graph')),
	CONSTRAINT "ck_consistency_sweeps_status" CHECK ("consistency_sweeps"."status" IN ('running', 'done', 'error'))
);
--> statement-breakpoint
ALTER TABLE "consistency_flags" ADD CONSTRAINT "consistency_flags_sweep_id_consistency_sweeps_id_fk" FOREIGN KEY ("sweep_id") REFERENCES "public"."consistency_sweeps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consistency_flags" ADD CONSTRAINT "consistency_flags_primary_claim_id_claims_id_fk" FOREIGN KEY ("primary_claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consistency_flags" ADD CONSTRAINT "consistency_flags_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consistency_sweeps" ADD CONSTRAINT "consistency_sweeps_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_consistency_flags_primary" ON "consistency_flags" USING btree ("primary_claim_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_consistency_flags_action" ON "consistency_flags" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "idx_consistency_flags_sweep" ON "consistency_flags" USING btree ("sweep_id");--> statement-breakpoint
CREATE INDEX "idx_consistency_sweeps_tag" ON "consistency_sweeps" USING btree ("tag_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_consistency_sweeps_started" ON "consistency_sweeps" USING btree ("started_at");