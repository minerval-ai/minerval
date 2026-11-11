-- The graph's own content carries a label (src/labels.ts): nodes, edges,
-- lateral links, arguments and their premises, passages and attached URLs,
-- tags and taggings, quantity definitions, readings and cuts, answer
-- relations, what each judgment rested on, formal statements, Lean checks,
-- proof attempts and the Curator's record of its surgery. Each gets the
-- "sensitivity_label" column the judgments got in 0121, 'public' on every
-- row that exists. A row is stamped with the label of the run that writes
-- it, and work that starts from a claim itself runs at the claim's label.
-- Nothing reads the column to hold anyone to a clearance.
--
-- No view is dropped or recreated. The public_read views that read these
-- tables (nodes, edges, arguments, tags) name their columns, and Postgres
-- stores a view with its columns already spelled out, so a column added to
-- a table never appears in a view that exists. The four in-force views are
-- over the judgment tables, which this migration does not alter.
--
-- Each ADD COLUMN has a constant default, so no table is rewritten, no
-- index is rebuilt, and the generated search vector and the embedding on
-- "claims" are not recomputed: the default is recorded in the catalog and
-- read for the rows that exist. It takes ACCESS EXCLUSIVE on its table for
-- that catalog change. Each foreign key takes SHARE ROW EXCLUSIVE on its
-- table and on "labels" and checks the existing rows with one sequential
-- scan. The migration is one transaction, so every lock is held to its
-- end: from the first statement that touches it, each of the eighteen
-- tables can be neither read nor written until the commit, and the scans
-- run inside that window.
--
-- The keys are added valid, not NOT VALID with a VALIDATE CONSTRAINT in a
-- later migration. On the public graph, counted when this was written,
-- "claims" holds about 2,100 rows, "claim_relationships" about 2,300 and
-- "arguments" about 1,100; "judgment_inputs" has a few rows for each
-- judgment written since 0115, out of about 1,500 assessments in all. Each
-- scan is a few milliseconds, so the whole window is well under a second.
-- NOT VALID would not shorten the ACCESS EXCLUSIVE locks, which the ADD
-- COLUMNs take either way, and would leave a stretch in which the catalog
-- says a label may be unchecked. A deployment whose tables are large
-- enough for the scans to matter should split the keys out the same way
-- before it applies this.
ALTER TABLE "answer_relations" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "argument_evidence_backlog" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "argument_instances" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "argument_subclaims" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "arguments" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_formalizations" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_links" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "lean_checks" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "proof_attempts" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "quantity_cuts" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "quantity_definitions" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "quantity_readings" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_events" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "taggings" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "answer_relations" ADD CONSTRAINT "answer_relations_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "argument_evidence_backlog" ADD CONSTRAINT "argument_evidence_backlog_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "argument_instances" ADD CONSTRAINT "argument_instances_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "argument_subclaims" ADD CONSTRAINT "argument_subclaims_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arguments" ADD CONSTRAINT "arguments_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_formalizations" ADD CONSTRAINT "claim_formalizations_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_links" ADD CONSTRAINT "claim_links_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_relationships" ADD CONSTRAINT "claim_relationships_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judgment_inputs" ADD CONSTRAINT "judgment_inputs_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lean_checks" ADD CONSTRAINT "lean_checks_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_attempts" ADD CONSTRAINT "proof_attempts_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_cuts" ADD CONSTRAINT "quantity_cuts_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_definitions" ADD CONSTRAINT "quantity_definitions_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quantity_readings" ADD CONSTRAINT "quantity_readings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_events" ADD CONSTRAINT "reconciliation_events_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "taggings" ADD CONSTRAINT "taggings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;