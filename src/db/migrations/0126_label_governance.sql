-- The rows of work and governance carry a label (src/labels.ts): a request,
-- its targets and the work recorded on it; a message in a node's inbox; a
-- petition, what is raised to a mandate, a mandate's decisions, its events
-- and the versions of its policy and terms; the mandate itself ("grants")
-- and the conversations it is drafted and discussed in, whose turns are on
-- the conversation's row; the Assistant's conversations and the pages kept
-- for a user; a review and a ruling on a contribution, a change to a
-- contributor's standing, an attachment; the audit trail on a claim and an
-- audit's findings; a consistency sweep and what it flags; a request to
-- the Curator; a prediction; a bounty and a prize claim; a lookout, its
-- feeds, the inputs queued for it and what it flags; a correspondent, its
-- inputs, its plan and its updates; a scoped ingest's focus; and the
-- record of each enqueue. Each gets the "sensitivity_label" column
-- "agent_runs" got in 0121, 'public' on every row that exists. A row is
-- stamped with the label of the run or request that writes it. Work that
-- belongs to one of these rows (a mandate's plan and sittings, a lookout's
-- poll, a request's ledger rows, a petition's follow-up) runs at that
-- row's label. A sitting works only what waits at its mandate's label;
-- nothing else reads the column.
--
-- No view is dropped or recreated. Seven public_read views read a table
-- altered here: "mandates" and "plan_items" over "grants",
-- "mandate_decisions", "petitions", "requests", "messages" over
-- "node_messages", and "changes" over several. Each names its columns,
-- and Postgres stores a view with its columns already spelled out, so the
-- new column does not appear in any of them.
--
-- Each ADD COLUMN has a constant default, so no table is rewritten and no
-- index is rebuilt: the default is recorded in the catalog and read for
-- the rows that exist. It takes ACCESS EXCLUSIVE on its table for that
-- catalog change and scans nothing. Each foreign key takes SHARE ROW
-- EXCLUSIVE on its table and on "labels" and checks the existing rows with
-- one sequential scan, which reads the label alone: the transcripts kept
-- out of line in the two conversation tables, an attachment's bytes and a
-- page's body are not fetched. The migration is one transaction, so every
-- lock is held to its end: from the first statement that touches it, each
-- of the thirty-five tables can be neither read nor written until the
-- commit, and the thirty-five scans run inside that window. Applied in the
-- same deploy as 0125, it runs in 0125's transaction as well, so the lock
-- 0125 takes on "agent_steps" and "llm_usage" is held through these scans
-- too. Applying 0125 on its own first keeps that window to 0125's own.
--
-- The keys are added valid. On the public graph, counted through the
-- public views when this was written, "node_messages" holds 1,612 rows,
-- "mandate_decisions" 254, "requests" 20, "petitions" 13 and "grants" 11.
-- The other thirty tables are not in a public view and were not counted.
-- Most hold a row for a thing people or agents did by hand, and are in the
-- tens or hundreds: conversations, pages, bounties, prize claims,
-- lookouts, correspondents, sweeps, attachments. Three grow with the
-- work: "audit_log" (a row for each structural edit to a claim),
-- "reputation_events" (a row for each reviewed contribution, of which the
-- public view counts 102) and "enqueue_events" (a row for each enqueue,
-- the largest: with 3,442 ledger rows and 1,612 messages, probably tens of
-- thousands). All three are narrow, so each scan is milliseconds and the
-- whole window is well under a second. That is an estimate and not a
-- count. A deployment whose "enqueue_events" or "audit_log" is large
-- enough for a scan to matter should add those keys NOT VALID and validate
-- them in a migration of its own, as 0125 does for "agent_steps".
ALTER TABLE "arbitration_results" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_pages" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_findings" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "bounties" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_predictions" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "consistency_flags" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "consistency_sweeps" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "contribution_reviews" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondent_events" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondent_plan_items" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondent_updates" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "correspondents" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "curation_requests" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "enqueue_events" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_conversations" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingest_focuses" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "lookout_events" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "lookout_feeds" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "lookout_flags" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "lookouts" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandate_decisions" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandate_events" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandate_inbox" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "mandate_policy_versions" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "node_messages" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "petitions" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "prize_claims" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_targets" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "request_work" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "arbitration_results" ADD CONSTRAINT "arbitration_results_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_pages" ADD CONSTRAINT "assistant_pages_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_findings" ADD CONSTRAINT "audit_findings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bounties" ADD CONSTRAINT "bounties_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_predictions" ADD CONSTRAINT "claim_predictions_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consistency_flags" ADD CONSTRAINT "consistency_flags_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consistency_sweeps" ADD CONSTRAINT "consistency_sweeps_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_reviews" ADD CONSTRAINT "contribution_reviews_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondent_events" ADD CONSTRAINT "correspondent_events_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondent_plan_items" ADD CONSTRAINT "correspondent_plan_items_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondent_updates" ADD CONSTRAINT "correspondent_updates_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondents" ADD CONSTRAINT "correspondents_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curation_requests" ADD CONSTRAINT "curation_requests_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enqueue_events" ADD CONSTRAINT "enqueue_events_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_conversations" ADD CONSTRAINT "grant_conversations_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_focuses" ADD CONSTRAINT "ingest_focuses_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookout_events" ADD CONSTRAINT "lookout_events_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookout_feeds" ADD CONSTRAINT "lookout_feeds_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookout_flags" ADD CONSTRAINT "lookout_flags_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookouts" ADD CONSTRAINT "lookouts_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_decisions" ADD CONSTRAINT "mandate_decisions_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_events" ADD CONSTRAINT "mandate_events_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_inbox" ADD CONSTRAINT "mandate_inbox_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_policy_versions" ADD CONSTRAINT "mandate_policy_versions_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_messages" ADD CONSTRAINT "node_messages_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petitions" ADD CONSTRAINT "petitions_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_claims" ADD CONSTRAINT "prize_claims_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reputation_events" ADD CONSTRAINT "reputation_events_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_targets" ADD CONSTRAINT "request_targets_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_work" ADD CONSTRAINT "request_work_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;