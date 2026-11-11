CREATE TABLE "assistant_allowances" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"surface" text DEFAULT 'web' NOT NULL,
	"origin" jsonb,
	"model" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"spent_micro_usd" bigint DEFAULT 0 NOT NULL,
	"allowed_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"turn_started_at" timestamp with time zone,
	"turn_heartbeat_at" timestamp with time zone,
	"turn_error" text,
	"turn_partial" text,
	"turn_note" text,
	"turn_cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"stop_requested" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_held_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"kind" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'held' NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assistant_allowances" ADD CONSTRAINT "assistant_allowances_user_id_contributors_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_user_id_contributors_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_held_actions" ADD CONSTRAINT "assistant_held_actions_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_held_actions" ADD CONSTRAINT "assistant_held_actions_user_id_contributors_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."contributors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assistant_convos_user" ON "assistant_conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_assistant_held_convo" ON "assistant_held_actions" USING btree ("conversation_id","created_at");