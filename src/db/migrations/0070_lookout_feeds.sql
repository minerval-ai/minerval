-- Feeds a lookout follows, and its inbox of their items (#305). Polling is
-- code; a feed's wake rule decides when waiting items are worth a funded
-- lookout run. Items are unique per feed, so a re-poll never duplicates.
CREATE TABLE "lookout_feed_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed_id" uuid NOT NULL,
	"lookout_id" uuid NOT NULL,
	"item_key" text NOT NULL,
	"url" text,
	"title" text,
	"author" text,
	"published_at" timestamp with time zone,
	"summary" text,
	"content" text,
	"body" text,
	"fetched_at" timestamp with time zone,
	"status" text DEFAULT 'new' NOT NULL,
	"reason" text,
	"triaged_by" text,
	"triaged_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "ck_lookout_feed_items_status" CHECK ("lookout_feed_items"."status" IN ('seen', 'new', 'deferred', 'ingested', 'skipped', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "lookout_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lookout_id" uuid NOT NULL,
	"url" text NOT NULL,
	"site_url" text,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"wake" text DEFAULT 'batch' NOT NULL,
	"batch_size" integer DEFAULT 10 NOT NULL,
	"max_wait_hours" integer DEFAULT 24 NOT NULL,
	"min_wake_hours" integer DEFAULT 4 NOT NULL,
	"poll_hours" integer DEFAULT 6 NOT NULL,
	"retain_days" integer DEFAULT 14 NOT NULL,
	"daily_ingest_cap" integer DEFAULT 5 NOT NULL,
	"seeded_at" timestamp with time zone,
	"last_polled_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_woke_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_lookout_feeds_status" CHECK ("lookout_feeds"."status" IN ('active', 'broken', 'removed')),
	CONSTRAINT "ck_lookout_feeds_wake" CHECK ("lookout_feeds"."wake" IN ('batch', 'each', 'heartbeat', 'paused', 'auto_ingest'))
);
--> statement-breakpoint
ALTER TABLE "lookout_feed_items" ADD CONSTRAINT "lookout_feed_items_feed_id_lookout_feeds_id_fk" FOREIGN KEY ("feed_id") REFERENCES "public"."lookout_feeds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookout_feed_items" ADD CONSTRAINT "lookout_feed_items_lookout_id_lookouts_id_fk" FOREIGN KEY ("lookout_id") REFERENCES "public"."lookouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookout_feeds" ADD CONSTRAINT "lookout_feeds_lookout_id_lookouts_id_fk" FOREIGN KEY ("lookout_id") REFERENCES "public"."lookouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lookout_feed_items_key" ON "lookout_feed_items" USING btree ("feed_id","item_key");--> statement-breakpoint
CREATE INDEX "idx_lookout_feed_items_inbox" ON "lookout_feed_items" USING btree ("lookout_id","first_seen_at") WHERE status IN ('new', 'deferred');--> statement-breakpoint
CREATE INDEX "idx_lookout_feed_items_url" ON "lookout_feed_items" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lookout_feeds_url" ON "lookout_feeds" USING btree ("lookout_id","url");--> statement-breakpoint
CREATE INDEX "idx_lookout_feeds_due" ON "lookout_feeds" USING btree ("next_poll_at") WHERE status = 'active';