-- What a run writes about itself carries a label (src/labels.ts): the
-- steps of its transcript ("agent_steps"), the usage rows of its model
-- calls ("llm_usage"), an investigation it launches and the report that
-- comes back ("research_runs"), a report it files about the machinery and
-- each later sighting of it ("agent_reports", "agent_report_sightings"), a
-- finding it notes and each later sighting ("agent_findings",
-- "agent_finding_sightings"), an audit it asks for ("audit_runs"), and the
-- parts of its setup, stored once by the hash of their text
-- ("setup_parts"). Each gets the "sensitivity_label" column "agent_runs"
-- got in 0121, 'public' on every row that exists. A step carries the label
-- of the run it belongs to. The others carry the label of the run or the
-- request that writes them, and a setup part the label of the run that
-- first stored its text. Nothing reads the column to hold anyone to a
-- clearance.
--
-- The run log's hash chain is untouched: a step's hash is taken over
-- prev_hash, seq, kind and content, and this column is none of them. The
-- label a run worked at is under the chain already, in its prompt step's
-- setup.
--
-- No view is dropped or recreated. No public_read view reads any of the
-- nine tables.
--
-- Each ADD COLUMN has a constant default, so no table is rewritten and no
-- index is rebuilt: the default is recorded in the catalog and read for
-- the rows that exist. It takes ACCESS EXCLUSIVE on its table for that
-- catalog change and scans nothing. The migration is one transaction, so
-- every lock is held to its end, and the statements are in an order that
-- keeps the two busy tables locked for the shortest time: the seven small
-- tables first, columns and keys, then "llm_usage", then "agent_steps"
-- last, so nothing in this file runs after the lock on "agent_steps" is
-- taken. The migrator applies every pending migration in one transaction
-- (drizzle-orm's migrate), so a migration applied in the same deploy after
-- this one runs inside that window too, and its scans add to it.
--
-- Eight of the keys are added valid: SHARE ROW EXCLUSIVE on the table and
-- on "labels", and one sequential scan of the rows that exist. None of
-- these tables is in a public view, so none could be counted from outside
-- when this was written. For scale, the public graph then held 2,115
-- nodes, 1,488 judgments and 3,442 ledger rows. The seven small tables
-- have at most a few rows for each of those (a report, a finding, an
-- audit, an investigation, a version of a prompt), so their scans are
-- milliseconds. "llm_usage" has a row for every model call, which is
-- probably hundreds of thousands of rows and may be a few million; its
-- rows are narrow (ids, counts and a cost, no text), so the scan is well
-- under a second at the low end and a few seconds at the high end, during
-- which a model call's usage insert waits. That is an estimate and not a
-- count: a deployment that knows the table to be larger should add this
-- key NOT VALID as well.
--
-- The key on "agent_steps" is added NOT VALID, and validating it is left
-- to a later migration (ALTER TABLE "agent_steps" VALIDATE CONSTRAINT
-- "agent_steps_sensitivity_label_labels_name_fk"). It is the largest
-- table by far: a row for every turn of every run, each holding the turn
-- verbatim, and every run in progress appends to it. Validating here would
-- scan it while this transaction holds ACCESS EXCLUSIVE on it from the ADD
-- COLUMN, so every run would stop writing its log for the length of the
-- scan, and in record mode a run does not finish until its log is written.
-- How long the scan would be cannot be bounded from outside. NOT VALID
-- skips the scan and nothing else: the key is enforced on every row
-- written or changed from now on, and the rows that exist all hold the
-- default, 'public', which "labels" has had since 0121. VALIDATE
-- CONSTRAINT in a migration of its own takes SHARE UPDATE EXCLUSIVE, which
-- lets inserts through while it scans. Until then the catalog says the key
-- is not validated, and tests/db/label-runs.test.ts says so too, so that
-- the follow-up is not forgotten.
ALTER TABLE "agent_finding_sightings" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_findings" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_report_sightings" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "research_runs" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "setup_parts" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_finding_sightings" ADD CONSTRAINT "agent_finding_sightings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_findings" ADD CONSTRAINT "agent_findings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_report_sightings" ADD CONSTRAINT "agent_report_sightings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_reports" ADD CONSTRAINT "agent_reports_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_runs" ADD CONSTRAINT "audit_runs_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_runs" ADD CONSTRAINT "research_runs_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_parts" ADD CONSTRAINT "setup_parts_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action NOT VALID;
