CREATE TABLE "taggings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_id" uuid NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"source" text NOT NULL,
	"confidence" real,
	"reasoning" text,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_taggings_subject_kind" CHECK ("taggings"."subject_kind" IN ('claim', 'source', 'mandate'))
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"embedding" vector(1536),
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into" uuid,
	"created_by" text DEFAULT 'system' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_tags_status" CHECK ("tags"."status" IN ('active', 'merged'))
);
--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "tagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "tagging_leased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "tagging_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "taggings" ADD CONSTRAINT "taggings_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_merged_into_tags_id_fk" FOREIGN KEY ("merged_into") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_taggings_tag_subject" ON "taggings" USING btree ("tag_id","subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "idx_taggings_subject" ON "taggings" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "idx_taggings_tag" ON "taggings" USING btree ("tag_id","subject_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tags_slug" ON "tags" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_tags_status" ON "tags" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_claims_tagging_queue" ON "claims" USING btree ("importance" DESC NULLS LAST,"updated_at") WHERE tagged_at IS NULL AND state = 'active';