-- Control (docs/organizations.md, phase 5): hosting tokens for deployments
-- Minerval provisions, which may alone say they run on its machines; a
-- deployment's own key on the organization's log; the allowance and a
-- request carried by hand on the deployment's connection; and which
-- deployment registered a publishing key.
CREATE TABLE "hosted_deployment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"note" text NOT NULL,
	"made_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deployment_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "hosted_deployment_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "organization_log" DROP CONSTRAINT "ck_organization_log_credential";--> statement-breakpoint
ALTER TABLE "public_graph_connection" DROP CONSTRAINT "ck_public_graph_connection_state";--> statement-breakpoint
ALTER TABLE "deployment_connect_requests" ADD COLUMN "hosting_token_id" uuid;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "hosted_by_minerval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "public_graph_connection" ADD COLUMN "allowance_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "public_graph_connection" ADD COLUMN "allowance_left_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "public_graph_connection" ADD COLUMN "by_hand_request" text;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "deployment_id" uuid;--> statement-breakpoint
ALTER TABLE "hosted_deployment_tokens" ADD CONSTRAINT "hosted_deployment_tokens_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_log" ADD CONSTRAINT "ck_organization_log_credential" CHECK ("organization_log"."credential" IN ('session', 'operator', 'deployment'));--> statement-breakpoint
ALTER TABLE "public_graph_connection" ADD CONSTRAINT "ck_public_graph_connection_state" CHECK ("public_graph_connection"."state" IN ('waiting', 'connected', 'denied', 'expired', 'by_hand'));