CREATE TABLE "usage_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"period" date NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"spent_micro_owls" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_via" text,
	"receipt" jsonb,
	"last_attempt_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "usage_reports_received" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"period" date NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"body" text NOT NULL,
	"body_hash" text NOT NULL,
	"spent_micro_owls" bigint NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_reports_received" ADD CONSTRAINT "usage_reports_received_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_reports_period_revision" ON "usage_reports" USING btree ("period","revision");--> statement-breakpoint
CREATE INDEX "idx_usage_reports_unsent" ON "usage_reports" USING btree ("period") WHERE "usage_reports"."sent_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_reports_received" ON "usage_reports_received" USING btree ("account_id","deployment_id","period","revision");