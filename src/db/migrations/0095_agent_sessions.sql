CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"node_id" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"transcript" jsonb,
	"model" text,
	"awaiting" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"replies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payer" jsonb,
	"budget_left_micro_usd" bigint DEFAULT 0 NOT NULL,
	"suspended_at" timestamp with time zone,
	"deadline" timestamp with time zone,
	"resumed_at" timestamp with time zone,
	"resumes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_sessions_status_check" CHECK ("agent_sessions"."status" IN ('running', 'waiting', 'ready', 'expired', 'closed'))
);
--> statement-breakpoint
ALTER TABLE "node_messages" ADD COLUMN "reply_to_session" uuid;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "reply_to_session" uuid;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "deliver_to_node" uuid;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_node_id_claims_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_sessions_node" ON "agent_sessions" USING btree ("node_id","status");--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_deliver_to_node_claims_id_fk" FOREIGN KEY ("deliver_to_node") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;