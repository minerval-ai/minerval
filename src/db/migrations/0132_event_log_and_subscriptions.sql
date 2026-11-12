CREATE TABLE "event_router_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"node_id" uuid,
	"action_id" uuid,
	"grant_id" uuid,
	"source_id" uuid,
	"refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitivity_label" text DEFAULT 'public' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscriber_kind" text NOT NULL,
	"subscriber_ref" text NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"condition" jsonb,
	"due_at" timestamp with time zone,
	"delivery" text DEFAULT 'wake' NOT NULL,
	"once" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"deliveries" integer DEFAULT 0 NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "subscriptions_delivery_check" CHECK ("subscriptions"."delivery" IN ('wake', 'queue')),
	CONSTRAINT "subscriptions_subscriber_check" CHECK ("subscriptions"."subscriber_kind" IN ('session', 'mandate_inbox', 'node_inbox', 'lookout', 'correspondent'))
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "wake_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_events_node" ON "events" USING btree ("node_id","seq");--> statement-breakpoint
CREATE INDEX "idx_events_action" ON "events" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "idx_events_grant" ON "events" USING btree ("grant_id","seq");--> statement-breakpoint
CREATE INDEX "idx_events_kind" ON "events" USING btree ("kind","seq");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_subscriber" ON "subscriptions" USING btree ("subscriber_kind","subscriber_ref","active");--> statement-breakpoint
CREATE INDEX "idx_subscriptions_due" ON "subscriptions" USING btree ("due_at") WHERE "subscriptions"."active" AND "subscriptions"."due_at" IS NOT NULL;