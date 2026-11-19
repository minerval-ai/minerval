-- A verified domain for an organization (docs/organizations.md, phase 6):
-- the TXT record's token, and when checks found it.
CREATE TABLE "organization_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"token" text NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organization_domains" ADD CONSTRAINT "organization_domains_organization_id_contributors_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_domains" ADD CONSTRAINT "organization_domains_added_by_contributors_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organization_domains_live" ON "organization_domains" USING btree ("organization_id","domain") WHERE "organization_domains"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_organization_domains_domain" ON "organization_domains" USING btree ("domain");