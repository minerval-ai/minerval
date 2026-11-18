-- Connected deployments, the public graph's side (#1118, phase 2;
-- docs/organizations.md, "A deployment's identity" and "Connecting").
-- A deployment belongs to an organization and signs its requests with a
-- key that never leaves it; deployment_grants says what it may do; a
-- connect request is the code an organization admin approves; and the
-- writes a deployment signed, and the nonces of the last ten minutes, are
-- kept so that the organization can see them and a write cannot be
-- replayed.
--
-- None of the five tables carries "sensitivity_label": they say who a
-- request is, as api_keys does. All are new and empty; nothing else is
-- touched.
CREATE TABLE "deployment_connect_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"public_key" text NOT NULL,
	"key_id" text NOT NULL,
	"suggested_name" text NOT NULL,
	"hosting" text NOT NULL,
	"asked_grants" text[] NOT NULL,
	"report_identifier" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"deployment_id" uuid,
	CONSTRAINT "deployment_connect_requests_code_unique" UNIQUE("code"),
	CONSTRAINT "ck_deployment_connect_requests_state" CHECK ("deployment_connect_requests"."state" IN ('waiting', 'approved', 'denied')),
	CONSTRAINT "ck_deployment_connect_requests_hosting" CHECK ("deployment_connect_requests"."hosting" IN ('own_machines', 'minerval', 'third_party'))
);
--> statement-breakpoint
CREATE TABLE "deployment_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"grant" text NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_by" uuid,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "ck_deployment_grants_grant" CHECK ("deployment_grants"."grant" IN ('read_feed', 'report_usage', 'publish', 'act'))
);
--> statement-breakpoint
CREATE TABLE "deployment_request_nonces" (
	"key_id" text NOT NULL,
	"nonce" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deployment_request_nonces_key_id_nonce_pk" PRIMARY KEY("key_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "deployment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"method" text NOT NULL,
	"route" text NOT NULL,
	"status" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"hosting" text NOT NULL,
	"public_key" text NOT NULL,
	"key_id" text NOT NULL,
	"report_identifier" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_by" uuid,
	"retired_at" timestamp with time zone,
	CONSTRAINT "ck_deployments_hosting" CHECK ("deployments"."hosting" IN ('own_machines', 'minerval', 'third_party'))
);
--> statement-breakpoint
ALTER TABLE "deployment_connect_requests" ADD CONSTRAINT "deployment_connect_requests_decided_by_contributors_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_connect_requests" ADD CONSTRAINT "deployment_connect_requests_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_grants" ADD CONSTRAINT "deployment_grants_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_grants" ADD CONSTRAINT "deployment_grants_granted_by_contributors_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_grants" ADD CONSTRAINT "deployment_grants_withdrawn_by_contributors_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_requests" ADD CONSTRAINT "deployment_requests_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_organization_id_contributors_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_approved_by_contributors_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_retired_by_contributors_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_deployment_connect_requests_key" ON "deployment_connect_requests" USING btree ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deployment_grants_live" ON "deployment_grants" USING btree ("deployment_id","grant") WHERE "deployment_grants"."withdrawn_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_deployment_request_nonces_seen" ON "deployment_request_nonces" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "idx_deployment_requests_deployment" ON "deployment_requests" USING btree ("deployment_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deployments_live_key" ON "deployments" USING btree ("key_id") WHERE "deployments"."retired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_deployments_org" ON "deployments" USING btree ("organization_id");