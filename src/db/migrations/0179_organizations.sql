-- Organizations as their own kind of account (#1118; docs/organizations.md,
-- "Organizations on minerval.ai"). contributors.kind says what an account is:
-- a person (every row that exists), an organization, or the platform account,
-- which is marked here. An organization's admins and members, the invitations
-- that add them, its log, and a shared login's request to become an
-- organization are four new tables.
--
-- None of them carries "sensitivity_label": like contributors and api_keys
-- they say who an account is. Their routes act for a signed-in person on
-- their own organizations and write nothing a label holds.
--
-- What it locks: ADD COLUMN with a constant default rewrites nothing, and the
-- CHECK on contributors scans it once. The new tables are empty.
CREATE TABLE "account_conversions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"first_admin_id" uuid NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organization_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"made_by" uuid,
	"made_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "organization_invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "ck_organization_invitations_role" CHECK ("organization_invitations"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "organization_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid,
	"credential" text NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_organization_log_credential" CHECK ("organization_log"."credential" IN ('session', 'operator'))
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by" uuid,
	"removed_at" timestamp with time zone,
	CONSTRAINT "ck_organization_members_role" CHECK ("organization_members"."role" IN ('admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "contributors" ADD COLUMN "kind" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
UPDATE "contributors" SET "kind" = 'platform' WHERE "external_id" = 'platform:minerval';--> statement-breakpoint
ALTER TABLE "account_conversions" ADD CONSTRAINT "account_conversions_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_conversions" ADD CONSTRAINT "account_conversions_first_admin_id_contributors_id_fk" FOREIGN KEY ("first_admin_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_contributors_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_made_by_contributors_id_fk" FOREIGN KEY ("made_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_accepted_by_contributors_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_cancelled_by_contributors_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_log" ADD CONSTRAINT "organization_log_organization_id_contributors_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_log" ADD CONSTRAINT "organization_log_actor_id_contributors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_contributors_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_added_by_contributors_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_removed_by_contributors_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_account_conversions_open" ON "account_conversions" USING btree ("account_id") WHERE "account_conversions"."accepted_at" IS NULL AND "account_conversions"."cancelled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_account_conversions_first_admin" ON "account_conversions" USING btree ("first_admin_id");--> statement-breakpoint
CREATE INDEX "idx_organization_invitations_org" ON "organization_invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_organization_log_org" ON "organization_log" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_organization_members_live" ON "organization_members" USING btree ("organization_id","account_id") WHERE "organization_members"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_organization_members_account" ON "organization_members" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "contributors" ADD CONSTRAINT "ck_contributors_kind" CHECK ("contributors"."kind" IN ('person', 'organization', 'platform'));