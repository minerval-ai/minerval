-- Connecting, revised (docs/organizations.md, "Connecting"): a deployment
-- says which grants its settings need and why, and where its own site is,
-- for links back to it; and keeps where it runs, as the administrator who
-- connected it answered.
ALTER TABLE "deployment_connect_requests" ADD COLUMN "needs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment_connect_requests" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "public_graph_connection" ADD COLUMN "hosting" text;