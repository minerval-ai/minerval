CREATE TABLE "node_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"sender_kind" text NOT NULL,
	"sender_node_id" uuid,
	"sender_ref" text,
	"body" text NOT NULL,
	"paid" boolean DEFAULT false NOT NULL,
	"reply_to" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"outcome" text,
	"outcome_note" text,
	"answered_at" timestamp with time zone,
	CONSTRAINT "node_messages_outcome_check" CHECK ("node_messages"."outcome" IS NULL OR "node_messages"."outcome" IN ('changed', 'no_change', 'disagree'))
);
--> statement-breakpoint
ALTER TABLE "node_messages" ADD CONSTRAINT "node_messages_node_id_claims_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_messages" ADD CONSTRAINT "node_messages_sender_node_id_claims_id_fk" FOREIGN KEY ("sender_node_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_messages" ADD CONSTRAINT "node_messages_reply_to_node_messages_id_fk" FOREIGN KEY ("reply_to") REFERENCES "public"."node_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_node_messages_unread" ON "node_messages" USING btree ("node_id","created_at") WHERE read_at IS NULL;--> statement-breakpoint
CREATE INDEX "idx_node_messages_sender" ON "node_messages" USING btree ("sender_node_id");--> statement-breakpoint
-- Carry what claims.steward_context holds for a waiting slot into the inbox,
-- so nothing queued before this migration is lost when the column is retired.
INSERT INTO "node_messages" ("node_id", "trigger", "sender_kind", "body")
SELECT id, COALESCE(steward_trigger, 'staleness_check'), 'system', steward_context
  FROM claims
 WHERE COALESCE(steward_context, '') <> ''
   AND (steward_state = 'pending' OR (steward_state = 'running' AND steward_requeued));
