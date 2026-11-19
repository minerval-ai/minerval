-- Billing on the organization (docs/organizations.md, phase 7): how each
-- usage report received came, signed by a deployment or uploaded by an admin.
ALTER TABLE "usage_reports_received" ADD COLUMN "received_via" text DEFAULT 'account_key' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_reports_received" ADD COLUMN "connected_deployment_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_reports_received" ADD COLUMN "uploaded_by" uuid;