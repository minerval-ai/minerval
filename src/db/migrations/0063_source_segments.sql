CREATE TABLE "source_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"parent_id" uuid,
	"ordinal" integer NOT NULL,
	"label" text,
	"kind" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"text_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_source_segments_kind" CHECK ("source_segments"."kind" IN ('section', 'passage', 'table', 'note', 'reference')),
	CONSTRAINT "ck_source_segments_span" CHECK ("source_segments"."char_start" >= 0 AND "source_segments"."char_end" >= "source_segments"."char_start")
);
--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "segment_id" uuid;--> statement-breakpoint
ALTER TABLE "source_segments" ADD CONSTRAINT "source_segments_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_segments" ADD CONSTRAINT "source_segments_parent_id_source_segments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."source_segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_segments_order" ON "source_segments" USING btree ("source_id","ordinal");--> statement-breakpoint
CREATE INDEX "idx_source_segments_parent" ON "source_segments" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "claim_instances" ADD CONSTRAINT "claim_instances_segment_id_source_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."source_segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_instances_segment" ON "claim_instances" USING btree ("segment_id");