CREATE TABLE "argument_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"argument_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"verbatim_text" text NOT NULL,
	"context" text,
	"stance" text NOT NULL,
	"reading" text,
	"stated_shows" jsonb,
	"speaker" text,
	"publication" text,
	"source_date" text,
	"link" text,
	"created_by" text NOT NULL,
	"segment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "argument_instances" ADD CONSTRAINT "argument_instances_argument_id_arguments_id_fk" FOREIGN KEY ("argument_id") REFERENCES "public"."arguments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "argument_instances" ADD CONSTRAINT "argument_instances_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "argument_instances" ADD CONSTRAINT "argument_instances_segment_id_source_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."source_segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_argument_instances_argument" ON "argument_instances" USING btree ("argument_id");--> statement-breakpoint
CREATE INDEX "idx_argument_instances_source" ON "argument_instances" USING btree ("source_id");