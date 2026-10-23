-- Scoped ingest: an ingest may carry a focus, and every extraction of a
-- source records what it was read for (null = the whole document), so a
-- source page can say how much of a document the graph holds and a later
-- ingest with another focus extracts what is missing.
CREATE TABLE "ingest_focuses" (
	"exclusion_group" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"focus" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"focus" text,
	"grant_id" uuid,
	"job_id" uuid,
	"claims_extracted" integer DEFAULT 0 NOT NULL,
	"claims_created" integer DEFAULT 0 NOT NULL,
	"claims_matched" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lookout_feeds" ADD COLUMN "ingest_focus" text;--> statement-breakpoint
ALTER TABLE "source_extractions" ADD CONSTRAINT "source_extractions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_extractions" ADD CONSTRAINT "source_extractions_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_source_extractions_source" ON "source_extractions" USING btree ("source_id","created_at");