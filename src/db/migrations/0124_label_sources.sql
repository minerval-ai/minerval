-- Sources and what is read from them carry a label (src/labels.ts): the
-- passages recorded from a document (claim_instances), the readings of
-- them and the log of those readings, the document's segments, the notices
-- against it, what it has been extracted for, the edges between documents
-- and from an assertion to the document it draws on, a claim's origins and
-- its source map, examinations with their coverage, findings, citations
-- and the Audit agent's notes, recorded stakes, a mandate's ingested
-- sources, a page analysis kept for the next reader, and a feed item with
-- the page fetched for it. Each gets the "sensitivity_label" column
-- "sources" got in 0121, 'public' on every row that exists. A row is
-- stamped with the label of the run that writes it, and work that starts
-- from a source itself runs at the source's label. Nothing reads the
-- column to hold anyone to a clearance.
--
-- On "source_segments" the new column sits beside "label", which is a
-- segment's heading and is not touched.
--
-- No view is dropped or recreated. One public_read view reads a table
-- altered here, public_read.instances over "claim_instances", and it names
-- its columns; Postgres stores a view with its columns already spelled
-- out, so the new column does not appear in it. public_read.sources is
-- over "sources", which this migration does not alter.
--
-- Each ADD COLUMN has a constant default, so no table is rewritten and no
-- index is rebuilt: the default is recorded in the catalog and read for
-- the rows that exist. It takes ACCESS EXCLUSIVE on its table for that
-- catalog change and scans nothing. Each foreign key takes SHARE ROW
-- EXCLUSIVE on its table and on "labels" and checks the existing rows with
-- one sequential scan. The scan reads the label alone, so the page text
-- kept out of line in "lookout_feed_items" and the annotations in
-- "shared_page_analyses" are not fetched. The migration is one
-- transaction, so every lock is held to its end: from the first statement
-- that touches it, each of the nineteen tables can be neither read nor
-- written until the commit, and the nineteen scans run inside that window.
--
-- The keys are added valid, not NOT VALID with a VALIDATE CONSTRAINT in a
-- later migration. On the public graph, counted through the public views
-- when this was written, "sources" holds 923 rows and "claim_instances"
-- 1,770. The other seventeen tables are not in any public view and were
-- not counted. The largest of them is "source_segments", which has a row
-- for each section and passage of each source whose text is stored: with
-- 923 sources that is probably tens of thousands of rows and at most a
-- few hundred thousand, which is an estimate and not a count. Its rows
-- are narrow (three ids, three numbers, a heading, a kind and a hash; the
-- text stays in "sources", and there is no embedding on the table), so
-- even at the high end that scan is tens of milliseconds and the whole
-- window stays under a second. NOT VALID would not shorten the ACCESS EXCLUSIVE locks, which
-- the ADD COLUMNs take either way, and would leave a stretch in which the
-- catalog says a label may be unchecked. A deployment whose tables are
-- large enough for the scans to matter should split the keys out the same
-- way before it applies this.
ALTER TABLE "audit_notes" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_instance_reading_log" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_instance_readings" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_provenance_edges" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_provenance_roots" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_source_maps" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "examination_coverage" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "examination_findings" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "examinations" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_sources" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "lookout_feed_items" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "reading_citations" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_page_analyses" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_events" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_extractions" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_interests" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_relationships" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_segments" ADD COLUMN "sensitivity_label" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_notes" ADD CONSTRAINT "audit_notes_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_instance_reading_log" ADD CONSTRAINT "claim_instance_reading_log_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_instance_readings" ADD CONSTRAINT "claim_instance_readings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_instances" ADD CONSTRAINT "claim_instances_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_provenance_edges" ADD CONSTRAINT "claim_provenance_edges_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_provenance_roots" ADD CONSTRAINT "claim_provenance_roots_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_source_maps" ADD CONSTRAINT "claim_source_maps_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_coverage" ADD CONSTRAINT "examination_coverage_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examination_findings" ADD CONSTRAINT "examination_findings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examinations" ADD CONSTRAINT "examinations_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_sources" ADD CONSTRAINT "grant_sources_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lookout_feed_items" ADD CONSTRAINT "lookout_feed_items_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_citations" ADD CONSTRAINT "reading_citations_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_page_analyses" ADD CONSTRAINT "shared_page_analyses_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_extractions" ADD CONSTRAINT "source_extractions_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_interests" ADD CONSTRAINT "source_interests_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relationships" ADD CONSTRAINT "source_relationships_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_segments" ADD CONSTRAINT "source_segments_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;