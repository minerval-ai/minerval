CREATE TABLE "event_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"api_key_id" uuid,
	"event_name" text NOT NULL,
	"arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"url" text NOT NULL,
	"secret_sealed" text NOT NULL,
	"secret_key_id" text NOT NULL,
	"previous_secret_sealed" text,
	"previous_secret_key_id" text,
	"previous_secret_until" timestamp with time zone,
	"cursor" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"wake_at" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_event_id" text,
	"attempt_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"failed_since" timestamp with time zone,
	"last_error" text,
	"last_delivery_at" timestamp with time zone,
	"deliveries" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"router_subscription_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_subscriber_check";--> statement-breakpoint
ALTER TABLE "event_webhooks" ADD CONSTRAINT "event_webhooks_user_id_contributors_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_webhooks" ADD CONSTRAINT "event_webhooks_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_event_webhooks_key" ON "event_webhooks" USING btree ("subscription_key");--> statement-breakpoint
CREATE INDEX "idx_event_webhooks_user" ON "event_webhooks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_event_webhooks_due" ON "event_webhooks" USING btree ("wake_at","next_attempt_at","checked_at");--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_subscriber_check" CHECK ("subscriptions"."subscriber_kind" IN ('session', 'mandate_inbox', 'node_inbox', 'lookout', 'correspondent', 'webhook'));