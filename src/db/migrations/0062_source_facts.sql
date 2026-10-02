CREATE TABLE "source_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notice_url" text DEFAULT '' NOT NULL,
	"note" text,
	"detected_by" text NOT NULL,
	CONSTRAINT "ck_source_events_kind" CHECK ("source_events"."kind" IN ('correction', 'retraction', 'expression_of_concern', 'update', 'removal'))
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "authors" text[];--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "publisher" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "published_date" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "doi" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "archived_url" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "facts_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_events_unique" ON "source_events" USING btree ("source_id","kind","notice_url");--> statement-breakpoint
CREATE INDEX "idx_sources_doi" ON "sources" USING btree ("doi");--> statement-breakpoint
UPDATE "sources" SET "doi" = lower(regexp_replace(substring("url" from '10\.[0-9]{4,9}/[^[:space:]"<>?#]+'), '[.,;:]+$', '')) WHERE "doi" IS NULL AND "url" ~ '10\.[0-9]{4,9}/';
