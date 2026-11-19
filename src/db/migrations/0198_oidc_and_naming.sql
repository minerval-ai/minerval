-- minerval.ai as an OpenID Connect provider for organizations, and naming
-- the person who acted (docs/organizations.md, phase 8): the clients an
-- organization registers for its deployments and each sign-in through one;
-- its choice to name who acted, a deployment's for its acts outside, and
-- the name on a contribution.
CREATE TABLE "oidc_authorization_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL,
	"state" text,
	"nonce" text,
	"code_challenge" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"account_id" uuid,
	"approved_at" timestamp with time zone,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"denied_at" timestamp with time zone,
	CONSTRAINT "oidc_authorization_requests_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "organization_oidc_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "organization_oidc_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"names_people" boolean DEFAULT false NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outside_naming" (
	"id" text PRIMARY KEY DEFAULT 'this' NOT NULL,
	"names_person" boolean DEFAULT false NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_outside_naming_one" CHECK ("outside_naming"."id" = 'this')
);
--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "named_person" text;--> statement-breakpoint
ALTER TABLE "oidc_authorization_requests" ADD CONSTRAINT "oidc_authorization_requests_client_id_organization_oidc_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."organization_oidc_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_authorization_requests" ADD CONSTRAINT "oidc_authorization_requests_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_oidc_clients" ADD CONSTRAINT "organization_oidc_clients_organization_id_contributors_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_oidc_clients" ADD CONSTRAINT "organization_oidc_clients_created_by_contributors_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_contributors_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_set_by_contributors_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outside_naming" ADD CONSTRAINT "outside_naming_set_by_contributors_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_oidc_authorization_requests_client" ON "oidc_authorization_requests" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_organization_oidc_clients_org" ON "organization_oidc_clients" USING btree ("organization_id");