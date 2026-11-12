-- Who may do what in a private deployment (src/permissions.ts): the parties
-- whose material a deployment holds, the grants of each permission to an
-- account or a group, the groups a person's latest sign-in carried, a log
-- of the other administrative changes, and whose material a source is.
-- Nothing reads or writes any of it on the public graph: the tables are
-- empty there and "sources"."party_id" is null on every row.
CREATE TABLE "account_groups" (
	"account_id" uuid NOT NULL,
	"group_name" text NOT NULL,
	"asserted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_groups_account_id_group_name_pk" PRIMARY KEY("account_id","group_name")
);
--> statement-breakpoint
CREATE TABLE "administrative_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_id" uuid,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_own_organization" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permission_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"permission" text NOT NULL,
	"account_id" uuid,
	"group_name" text,
	"label" text,
	"party_id" uuid,
	"granted_by" uuid,
	"granted_via" text DEFAULT 'administrator' NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_by" uuid,
	"removed_at" timestamp with time zone,
	CONSTRAINT "ck_permission_grants_permission" CHECK ("permission_grants"."permission" IN ('direct', 'release', 'fund', 'read', 'read_sources', 'administer')),
	CONSTRAINT "ck_permission_grants_subject" CHECK (("permission_grants"."account_id" IS NULL) <> ("permission_grants"."group_name" IS NULL)),
	CONSTRAINT "ck_permission_grants_label_scope" CHECK (("permission_grants"."label" IS NOT NULL) = ("permission_grants"."permission" IN ('read', 'read_sources'))),
	CONSTRAINT "ck_permission_grants_party_scope" CHECK (("permission_grants"."party_id" IS NOT NULL) = ("permission_grants"."permission" = 'release')),
	CONSTRAINT "ck_permission_grants_granted_via" CHECK ("permission_grants"."granted_via" IN ('administrator', 'first_administrator', 'operator')),
	CONSTRAINT "ck_permission_grants_granted_by" CHECK (("permission_grants"."granted_by" IS NOT NULL) = ("permission_grants"."granted_via" = 'administrator')),
	CONSTRAINT "ck_permission_grants_removal" CHECK (("permission_grants"."removed_by" IS NULL) OR ("permission_grants"."removed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "party_id" uuid;--> statement-breakpoint
ALTER TABLE "account_groups" ADD CONSTRAINT "account_groups_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "administrative_events" ADD CONSTRAINT "administrative_events_actor_id_contributors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_created_by_contributors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_label_labels_name_fk" FOREIGN KEY ("label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_granted_by_contributors_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "permission_grants_removed_by_contributors_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_groups_group" ON "account_groups" USING btree ("group_name");--> statement-breakpoint
CREATE INDEX "idx_administrative_events_time" ON "administrative_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_parties_name" ON "parties" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "uq_parties_own_organization" ON "parties" USING btree ("is_own_organization") WHERE is_own_organization;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_permission_grants_live_account" ON "permission_grants" USING btree ("account_id","permission",coalesce("label", ''),coalesce("party_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE removed_at IS NULL AND account_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_permission_grants_live_group" ON "permission_grants" USING btree ("group_name","permission",coalesce("label", ''),coalesce("party_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE removed_at IS NULL AND group_name IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_permission_grants_log" ON "permission_grants" USING btree ("granted_at");--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;