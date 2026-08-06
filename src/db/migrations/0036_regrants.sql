CREATE TABLE "regrants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_grant_id" uuid NOT NULL,
	"to_grant_id" uuid NOT NULL,
	"amount_micro_usd" bigint NOT NULL,
	"note" text,
	"refunded_micro_usd" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "regrants" ADD CONSTRAINT "regrants_from_grant_id_grants_id_fk" FOREIGN KEY ("from_grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "regrants" ADD CONSTRAINT "regrants_to_grant_id_grants_id_fk" FOREIGN KEY ("to_grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_regrants_from" ON "regrants" USING btree ("from_grant_id");--> statement-breakpoint
CREATE INDEX "idx_regrants_to" ON "regrants" USING btree ("to_grant_id");