CREATE TABLE "claim_state_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"successor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"cohort" text,
	"reconciliation_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "claim_state_changes" ADD CONSTRAINT "claim_state_changes_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_state_changes" ADD CONSTRAINT "claim_state_changes_reconciliation_event_id_reconciliation_events_id_fk" FOREIGN KEY ("reconciliation_event_id") REFERENCES "public"."reconciliation_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_state_changes" ADD CONSTRAINT "claim_state_changes_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_claim_state_changes_claim" ON "claim_state_changes" USING btree ("claim_id","created_at");--> statement-breakpoint
-- Merges already on record: each live merge's absorbed node gets the change
-- the merge made to it, from the Curator's own log. Writes only to the new
-- table; no existing row changes. Archives made before this table have no
-- record to copy (the script was a bare UPDATE); an operator records them
-- with scripts/archive-legacy-claims.ts --record-only.
INSERT INTO "claim_state_changes"
  ("claim_id", "from_state", "to_state", "actor", "reason", "successor_ids", "reconciliation_event_id", "created_at", "sensitivity_label")
SELECT c.id, COALESCE(e.payload->>'loser_prev_state', 'active'), 'merged', e.created_by, e.reasoning,
       ARRAY[(e.payload->>'survivor_id')::uuid], e.id, e.created_at, e.sensitivity_label
  FROM reconciliation_events e
  JOIN claims c ON c.id::text = e.payload->>'loser_id'
 WHERE e.operation = 'merge' AND e.reversed = false
   AND c.state = 'merged' AND c.merged_into::text = e.payload->>'survivor_id';
--> statement-breakpoint
-- The change stream, with lifecycle changes in it: a node archived, restored,
-- merged or deprecated is a change a reader of the stream should see.
CREATE OR REPLACE VIEW public_read.changes AS
SELECT 'assessed'::text AS kind, a.claim_id AS node_id, a.assessed_at AS at, a.status AS summary FROM assessments a
UNION ALL
SELECT 'message_arrived', m.node_id, m.created_at, m.trigger FROM node_messages m WHERE m.trigger <> 'message_reply'
UNION ALL
SELECT 'message_answered', m.node_id, m.answered_at, m.outcome FROM node_messages m WHERE m.answered_at IS NOT NULL
UNION ALL
SELECT 'work_commissioned', al.claim_id, al.created_at, al.exclusion_group FROM action_allocations al WHERE al.commissioned_by IS NOT NULL
UNION ALL
SELECT 'run_finished', a.claim_id, a.updated_at, a.kind FROM actions a WHERE a.status = 'done'
UNION ALL
SELECT 'contribution_accepted', c.claim_id, c.submitted_at, c.contribution_type FROM contributions c WHERE c.review_status = 'accepted'
UNION ALL
SELECT 'petition_decided', p.requester_node_id, p.decided_at, p.status FROM petitions p WHERE p.decided_at IS NOT NULL
UNION ALL
SELECT 'request_filed', r.keeper_claim_id, r.created_at, left(r.ask, 200) FROM requests r
UNION ALL
SELECT 'state_changed', s.claim_id, s.created_at,
       left(concat(s.from_state, ' -> ', s.to_state, ' by ', s.actor, ': ', s.reason,
                   CASE WHEN cardinality(s.successor_ids) > 0
                        THEN concat(' (successors: ', array_to_string(s.successor_ids, ', '), ')') ELSE '' END), 500)
  FROM claim_state_changes s;
--> statement-breakpoint
-- A new labelled table: where a deployment holds reads to a clearance
-- (0130), bring this table under the same policies now. A no-op where
-- 'public' is the only label.
SELECT minerval_enforcement_sync();
