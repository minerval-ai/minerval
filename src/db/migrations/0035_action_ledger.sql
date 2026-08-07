-- action_allocations is re-keyed to exclusion groups; pre-launch data
-- (dev/preview only) cannot be mapped and is cleared.
DELETE FROM action_allocations;--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"exclusion_group" text NOT NULL,
	"variant" text DEFAULT 'standard' NOT NULL,
	"claim_id" uuid,
	"target_ref" text,
	"label" text NOT NULL,
	"cost_est_micro_usd" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"metered_cost_micro_usd" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandate_valuations" (
	"grant_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"value_est" real NOT NULL,
	"rationale" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mandate_valuations_grant_id_action_id_pk" PRIMARY KEY("grant_id","action_id")
);
--> statement-breakpoint
ALTER TABLE "action_allocations" ALTER COLUMN "claim_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD COLUMN "exclusion_group" text NOT NULL;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD COLUMN "action_id" uuid;--> statement-breakpoint
ALTER TABLE "action_allocations" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_valuations" ADD CONSTRAINT "mandate_valuations_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_valuations" ADD CONSTRAINT "mandate_valuations_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_actions_group_variant" ON "actions" USING btree ("exclusion_group","variant");--> statement-breakpoint
CREATE INDEX "idx_actions_status_kind" ON "actions" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "idx_actions_claim" ON "actions" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_mandate_valuations_action" ON "mandate_valuations" USING btree ("action_id");--> statement-breakpoint
ALTER TABLE "action_allocations" ADD CONSTRAINT "action_allocations_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_action_allocations_group" ON "action_allocations" USING btree ("exclusion_group");--> statement-breakpoint
ALTER TABLE "action_allocations" DROP COLUMN "action";