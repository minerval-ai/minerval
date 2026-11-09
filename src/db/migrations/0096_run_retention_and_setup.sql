CREATE TABLE "setup_parts" (
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"source_path" text,
	"first_seen_commit" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_parts_kind_name_hash_pk" PRIMARY KEY("kind","name","hash"),
	CONSTRAINT "ck_setup_parts_kind" CHECK ("setup_parts"."kind" IN ('constitution', 'role', 'tool'))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "wrote_to_graph" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "assessments" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "question_assessments" ADD COLUMN "run_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_setup_parts_version" ON "setup_parts" USING btree ("kind","name","version");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_expirable" ON "agent_runs" USING btree ("started_at") WHERE wrote_to_graph = false;
--> statement-breakpoint
-- Every run already recorded is kept. Which of them wrote to the graph was
-- never recorded, so this errs toward keeping: at most one retention window
-- of runs, once.
UPDATE "agent_runs" SET "wrote_to_graph" = true;--> statement-breakpoint
-- Link existing verdicts to the Steward run that wrote them, where that run
-- is still recorded: the Steward run on the same claim that was open when
-- the verdict was written (the latest to start, should two overlap).
UPDATE "assessments" a SET "run_id" = (
  SELECT r.id FROM "agent_runs" r
   WHERE r.agent = 'steward'
     AND r.claim_id = a.claim_id
     AND r.started_at <= a.assessed_at
     AND (r.finished_at IS NULL OR r.finished_at >= a.assessed_at)
   ORDER BY r.started_at DESC
   LIMIT 1
) WHERE a.run_id IS NULL;--> statement-breakpoint
UPDATE "question_assessments" q SET "run_id" = (
  SELECT r.id FROM "agent_runs" r
   WHERE r.agent = 'steward'
     AND r.claim_id = q.claim_id
     AND r.started_at <= q.assessed_at
     AND (r.finished_at IS NULL OR r.finished_at >= q.assessed_at)
   ORDER BY r.started_at DESC
   LIMIT 1
) WHERE q.run_id IS NULL;
