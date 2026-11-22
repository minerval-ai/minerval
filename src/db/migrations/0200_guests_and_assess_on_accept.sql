CREATE TABLE "guest_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"address_hash" text,
	"granted_micro_usd" bigint NOT NULL,
	"carried_to_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contributions" ADD COLUMN "assess_on_accept" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "guest_passes" ADD CONSTRAINT "guest_passes_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_passes" ADD CONSTRAINT "guest_passes_carried_to_id_contributors_id_fk" FOREIGN KEY ("carried_to_id") REFERENCES "public"."contributors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_guest_passes_time" ON "guest_passes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_guest_passes_address" ON "guest_passes" USING btree ("address_hash","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_guest_passes_account" ON "guest_passes" USING btree ("account_id");