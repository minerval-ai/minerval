-- Connections that may write (docs/connections.md, "A tool granted to
-- write"): a pick may carry a write grant, kept with the administrator's
-- acknowledgement and reason; a tool may be priced, and its write calls
-- held for an administrator. A call records whether it wrote, what it was
-- charged, and, where it was held, who decided and when. Every existing
-- pick stays a pick of a tool that reads, at no price.
ALTER TABLE "connection_calls" ADD COLUMN "writes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "price_micro_usd" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "charged_micro_usd" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "charge_to" jsonb;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "tool_definition_hash" text;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "held_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "decided_by" uuid;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD COLUMN "writes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD COLUMN "write_reason" text;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD COLUMN "write_acknowledgement" text;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD COLUMN "write_granted_by" uuid;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD COLUMN "write_granted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD COLUMN "write_held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD COLUMN "call_price_micro_usd" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_calls" ADD CONSTRAINT "connection_calls_decided_by_contributors_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD CONSTRAINT "connection_tools_write_granted_by_contributors_id_fk" FOREIGN KEY ("write_granted_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connection_calls_writes" ON "connection_calls" USING btree ("connection_id","called_at") WHERE writes;--> statement-breakpoint
ALTER TABLE "connection_tools" ADD CONSTRAINT "ck_connection_tools_write_grant" CHECK (NOT "connection_tools"."writes" OR ("connection_tools"."write_reason" IS NOT NULL AND "connection_tools"."write_acknowledgement" IS NOT NULL AND "connection_tools"."write_granted_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "connection_tools" ADD CONSTRAINT "ck_connection_tools_held_writes" CHECK (NOT "connection_tools"."write_held" OR "connection_tools"."writes");--> statement-breakpoint
ALTER TABLE "connection_tools" ADD CONSTRAINT "ck_connection_tools_price" CHECK ("connection_tools"."call_price_micro_usd" >= 0);