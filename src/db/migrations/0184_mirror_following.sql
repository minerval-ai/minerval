-- Following the public graph, set up and kept in the app (#1118, phase 2c;
-- docs/organizations.md, "The mirror"): one row saying whether an
-- administrator started or paused following, and the feed keys this
-- deployment read from the public graph with which of them an administrator
-- accepted. The settings stay the operator's overrides.
--
-- What it locks: two new, empty tables.
CREATE TABLE "mirror_feed_keys" (
	"key_id" text PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"feed_id" uuid,
	"read_from" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mirror_following" (
	"id" text PRIMARY KEY DEFAULT 'this' NOT NULL,
	"state" text NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone,
	"paused_by" uuid,
	"paused_at" timestamp with time zone,
	"check_requested_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_check_error" text,
	CONSTRAINT "ck_mirror_following_one" CHECK ("mirror_following"."id" = 'this'),
	CONSTRAINT "ck_mirror_following_state" CHECK ("mirror_following"."state" IN ('following', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "mirror_feed_keys" ADD CONSTRAINT "mirror_feed_keys_accepted_by_contributors_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_following" ADD CONSTRAINT "mirror_following_started_by_contributors_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirror_following" ADD CONSTRAINT "mirror_following_paused_by_contributors_id_fk" FOREIGN KEY ("paused_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;