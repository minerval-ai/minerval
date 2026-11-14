CREATE TABLE "published_mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"face_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"ref" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"hash" text NOT NULL,
	"package" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);--> statement-breakpoint
ALTER TABLE "gate_settings" DROP CONSTRAINT "ck_gate_settings_kind";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP CONSTRAINT "ck_report_sendings_state";--> statement-breakpoint
ALTER TABLE "showings" DROP CONSTRAINT "ck_showings_kind";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP CONSTRAINT "report_sendings_sent_by_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "label_faces" ALTER COLUMN "for_label" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_requests" ADD COLUMN "asked_of_face_id" uuid;--> statement-breakpoint
ALTER TABLE "gate_settings" ADD COLUMN "delay_hours" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gate_settings" ADD COLUMN "batch_hours" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gates" ADD COLUMN "keep_current_mandate" uuid;--> statement-breakpoint
ALTER TABLE "gates" ADD COLUMN "keep_current_micro_usd" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "gates" ADD COLUMN "keep_current_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "label_faces" ADD COLUMN "publisher_account_id" uuid;--> statement-breakpoint
ALTER TABLE "report_sendings" ADD COLUMN "seen" integer;--> statement-breakpoint
ALTER TABLE "showing_pages" ADD COLUMN "funding_placed" boolean;--> statement-breakpoint
ALTER TABLE "shown_pages" ADD COLUMN "released_under" jsonb;--> statement-breakpoint
ALTER TABLE "shown_pages" ADD COLUMN "sent_outside_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shown_pages" ADD COLUMN "outside_ref" text;--> statement-breakpoint
ALTER TABLE "published_mandates" ADD CONSTRAINT "published_mandates_face_id_label_faces_id_fk" FOREIGN KEY ("face_id") REFERENCES "public"."label_faces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_mandates" ADD CONSTRAINT "published_mandates_account_id_contributors_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_mandates" ADD CONSTRAINT "published_mandates_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_published_mandates_sequence" ON "published_mandates" USING btree ("key_id","ref","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_published_mandates_hash" ON "published_mandates" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "idx_published_mandates_account" ON "published_mandates" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "label_faces" ADD CONSTRAINT "label_faces_publisher_account_id_contributors_id_fk" FOREIGN KEY ("publisher_account_id") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_feed_requests_asked_of" ON "feed_requests" USING btree ("asked_of_face_id");--> statement-breakpoint
CREATE INDEX "idx_label_faces_publisher" ON "label_faces" USING btree ("publisher_account_id");--> statement-breakpoint
ALTER TABLE "gate_settings" ADD CONSTRAINT "ck_gate_settings_delay" CHECK ("gate_settings"."delay_hours" >= 0 AND "gate_settings"."batch_hours" >= 0);--> statement-breakpoint
ALTER TABLE "gate_settings" ADD CONSTRAINT "ck_gate_settings_kind" CHECK ("gate_settings"."kind" IN ('*', 'page', 'answer', 'taken_up', 'funding', 'mandate', 'message', 'petition', 'statement', 'report', 'proposal'));--> statement-breakpoint
ALTER TABLE "label_faces" ADD CONSTRAINT "ck_label_faces_stands_for" CHECK (("label_faces"."for_label" IS NULL) <> ("label_faces"."publisher_account_id" IS NULL));--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "ck_showings_kind" CHECK ("showings"."kind" IN ('page', 'answer', 'taken_up', 'funding', 'mandate', 'message', 'petition', 'statement', 'report', 'proposal'));--> statement-breakpoint
-- Hand-written from here. What the outer boundary kept in tables of its own is carried onto the gate, and
-- then those tables are dropped (the generated statements that drop them were moved below this block, since
-- it reads them).
--
-- Keeping public versions current becomes the gate to outside asking a public mandate (gates.keep_current_mandate).
-- Where the standing choice was on and named a mandate, each gate to outside names it from now: versions made
-- before now were asked about, or were waiting, under the old queue, and are not asked about again.
UPDATE "gates" g
   SET "keep_current_mandate" = (s."value"->>'public_mandate_id')::uuid, "keep_current_since" = now()
  FROM "outward_settings" s
 WHERE s."key" = 'keep_public_current' AND s."value"->>'on' = 'true' AND s."value"->>'public_mandate_id' IS NOT NULL
   AND EXISTS (SELECT 1 FROM "redaction_policies" p WHERE p."boundary_id" = g."boundary_id" AND p."side" = 'page' AND p."to_outside");--> statement-breakpoint
-- It went with nobody acting and with no Redactor reading it, so those gates are set open for the kind, with
-- the delay and the batches the choice had. A gate made after this starts where every gate starts.
INSERT INTO "gate_settings" ("boundary_id", "kind", "scope", "mode", "delay_hours", "batch_hours", "set_by", "set_holding", "set_at", "from_rule", "sensitivity_label")
SELECT DISTINCT p."boundary_id", 'funding', 'boundary', 'open',
       LEAST(2160, GREATEST(0, COALESCE((s."value"->>'delay_hours')::numeric, 0)))::int,
       LEAST(2160, GREATEST(0, COALESCE((s."value"->>'batch_hours')::numeric, 0)))::int,
       s."set_by", s."holding", s."set_at", 'keeping public versions current, as it was set before it was a kind at the gate', p."from_label"
  FROM "outward_settings" s JOIN "redaction_policies" p ON p."side" = 'page' AND p."to_outside"
 WHERE s."key" = 'keep_public_current' AND s."value"->>'on' = 'true' AND s."value"->>'public_mandate_id' IS NOT NULL;--> statement-breakpoint
-- What was left out waits for a person: a setting for the mandate's work, or for the node and what sits under
-- it. (One node under one mandate becomes the node whoever pays, which asks less of the public graph, not more.)
INSERT INTO "gate_settings" ("boundary_id", "kind", "scope", "scope_ref", "mode", "set_by", "set_at", "from_rule", "sensitivity_label")
SELECT DISTINCT p."boundary_id", 'funding', CASE WHEN e."node_id" IS NOT NULL THEN 'under' ELSE 'mandate' END, COALESCE(e."node_id", e."grant_id"),
       'person', e."set_by", e."set_at", 'left out of keeping public versions current', p."from_label"
  FROM "keep_current_exceptions" e JOIN "redaction_policies" p ON p."side" = 'page' AND p."to_outside" AND p."from_label" = e."sensitivity_label"
 WHERE e."lifted_at" IS NULL AND COALESCE(e."node_id", e."grant_id") IS NOT NULL;--> statement-breakpoint
-- An agent's report is an item at the gate to outside, of the kind report, which starts with a person deciding.
-- Where the deployment had chosen to send redacted reports with nobody reading them, its gates to outside are
-- set to the Redactor's decision for that kind.
INSERT INTO "gate_settings" ("boundary_id", "kind", "scope", "mode", "set_by", "set_holding", "set_at", "from_rule", "sensitivity_label")
SELECT DISTINCT p."boundary_id", 'report', 'boundary', 'redactor', s."set_by", s."holding", s."set_at",
       'send redacted reports without asking each time, as it was set before reports went through the gate', p."from_label"
  FROM "outward_settings" s JOIN "redaction_policies" p ON p."side" = 'page' AND p."to_outside"
 WHERE s."key" = 'send_redacted_reports' AND s."value"->>'on' = 'true';--> statement-breakpoint
-- A report that was sent keeps its record, and so does one whose facts alone were sent. One that was waiting
-- for its own Redactor's pass or for a person is offered to the gate by the scheduler, so its row here and its
-- ledger row go.
UPDATE "report_sendings"
   SET "sent_at" = COALESCE("sent_at", "facts_sent_at"), "public_report_id" = COALESCE("public_report_id", "facts_public_report_id"),
       "seen" = COALESCE("facts_seen", 1)
 WHERE "sent_at" IS NOT NULL OR "facts_sent_at" IS NOT NULL;--> statement-breakpoint
DELETE FROM "report_sendings" WHERE "sent_at" IS NULL;--> statement-breakpoint
UPDATE "actions" SET "status" = 'cancelled', "updated_at" = now() WHERE "kind" = 'redact_report' AND "status" = 'open';--> statement-breakpoint
ALTER TABLE "keep_current_exceptions" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "keep_current_queue" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outward_settings" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "keep_current_exceptions" CASCADE;--> statement-breakpoint
DROP TABLE "keep_current_queue" CASCADE;--> statement-breakpoint
DROP TABLE "outward_settings" CASCADE;--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "body";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "policy_id";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "removals";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "action_id";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "redacted_at";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "redacted_by_model";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "sent_by";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "sent_holding";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "sent_under_standing_choice";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "facts_sent_at";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "facts_seen";--> statement-breakpoint
ALTER TABLE "report_sendings" DROP COLUMN "facts_public_report_id";
