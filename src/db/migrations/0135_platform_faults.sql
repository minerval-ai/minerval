CREATE TABLE "deployment_faults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reason" text NOT NULL,
	"provider" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"reported_at" timestamp with time zone,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "fault_reason" text;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "fault_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "fault_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "retry_after" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deployment_faults_open" ON "deployment_faults" USING btree ("reason","provider") WHERE "deployment_faults"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_deployment_faults_first_seen" ON "deployment_faults" USING btree ("first_seen_at");--> statement-breakpoint
-- A ledger row's wait on a platform fault (#971, services/deployment-fault.ts).
-- The executors skip a row until retry_after; one index serves that test.
CREATE INDEX "idx_actions_retry_after" ON "actions" USING btree ("retry_after") WHERE "retry_after" IS NOT NULL;--> statement-breakpoint
-- The wait ends when the row leaves open/running, whichever statement closes
-- it: the ledger closes rows from a dozen places (a completed run, a park, a
-- retired group, a reconcile sweep), and a row closed while it waited must
-- not read as waiting when its group's next piece of work reopens it.
CREATE OR REPLACE FUNCTION actions_clear_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status NOT IN ('open', 'running') THEN
    NEW.fault_reason := NULL;
    NEW.fault_since := NULL;
    NEW.fault_attempts := 0;
    NEW.retry_after := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "actions_clear_fault" BEFORE UPDATE OF "status" ON "actions" FOR EACH ROW EXECUTE FUNCTION actions_clear_fault();--> statement-breakpoint
-- The public ledger says why an open row is not running: the class of the
-- platform fault that stopped its last attempt, since when, and when the
-- platform tries it next. The class only; the provider's text is not here.
CREATE OR REPLACE VIEW public_read.ledger AS
SELECT a.id AS action_id, a.kind, a.variant, a.claim_id AS target_node_id, a.target_ref, a.label,
       CASE a.status WHEN 'done' THEN 'finished' WHEN 'superseded' THEN 'finished' ELSE a.status END AS status,
       a.metered_cost_micro_usd / 1e6 AS spent_owls, a.created_at AS opened_at, a.updated_at,
       CASE WHEN a.status = 'open' THEN a.fault_reason END AS waiting_on,
       CASE WHEN a.status = 'open' AND a.fault_reason IS NOT NULL THEN a.fault_since END AS waiting_since,
       CASE WHEN a.status = 'open' AND a.fault_reason IS NOT NULL THEN a.retry_after END AS next_attempt_at
  FROM actions a;
--> statement-breakpoint
-- A view in public_read made after enforcement is held by the step, or read-only
-- SQL would read every label through it until the next start (added when this
-- line of migrations met the private-deployment work; a database that had
-- already run this file is covered by the step in 0148).
SELECT minerval_enforcement_sync();
