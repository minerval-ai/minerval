CREATE TABLE "gate_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"boundary_id" uuid NOT NULL,
	"kind" text DEFAULT '*' NOT NULL,
	"scope" text DEFAULT 'boundary' NOT NULL,
	"scope_ref" uuid,
	"party_id" uuid,
	"mode" text NOT NULL,
	"set_by" uuid,
	"set_holding" text[] DEFAULT '{}' NOT NULL,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" uuid,
	"from_rule" text,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_gate_settings_mode" CHECK ("gate_settings"."mode" IN ('open', 'redactor', 'person')),
	CONSTRAINT "ck_gate_settings_scope" CHECK ("gate_settings"."scope" IN ('boundary', 'mandate', 'under', 'request') AND (("gate_settings"."scope" = 'boundary') = ("gate_settings"."scope_ref" IS NULL))),
	CONSTRAINT "ck_gate_settings_kind" CHECK ("gate_settings"."kind" IN ('*', 'page', 'answer', 'taken_up', 'funding', 'mandate', 'message', 'petition', 'statement'))
);
--> statement-breakpoint
CREATE TABLE "gates" (
	"boundary_id" uuid NOT NULL,
	"flow" text DEFAULT 'asked' NOT NULL,
	"backlog_shown" boolean DEFAULT true NOT NULL,
	"send_as_released" boolean DEFAULT true NOT NULL,
	"set_by" uuid,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "gates_sensitivity_label_boundary_id_pk" PRIMARY KEY("sensitivity_label","boundary_id"),
	CONSTRAINT "ck_gates_flow" CHECK ("gates"."flow" IN ('asked', 'everything'))
);
--> statement-breakpoint
ALTER TABLE "showing_pages" DROP CONSTRAINT "ck_showing_pages_kind";--> statement-breakpoint
ALTER TABLE "showings" DROP CONSTRAINT "ck_showings_scope";--> statement-breakpoint
ALTER TABLE "showing_pages" ALTER COLUMN "node_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "showing_pages" ALTER COLUMN "judgment_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "showing_pages" ALTER COLUMN "judgment_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "showings" ALTER COLUMN "node_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shown_pages" ALTER COLUMN "node_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shown_showings" ALTER COLUMN "node_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "showing_acts" ADD COLUMN "by" text DEFAULT 'process' NOT NULL;--> statement-breakpoint
ALTER TABLE "showing_acts" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "showing_acts" ADD COLUMN "until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "showing_pages" ADD COLUMN "version_key" text;--> statement-breakpoint
ALTER TABLE "showing_pages" ADD COLUMN "funds_wanted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "showing_removals" ADD COLUMN "made_by" uuid;--> statement-breakpoint
ALTER TABLE "showings" ADD COLUMN "kind" text DEFAULT 'page' NOT NULL;--> statement-breakpoint
ALTER TABLE "showings" ADD COLUMN "subject_ref" uuid;--> statement-breakpoint
ALTER TABLE "showings" ADD COLUMN "reply_ref" uuid;--> statement-breakpoint
ALTER TABLE "showings" ADD COLUMN "payer_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "shown_pages" ADD COLUMN "kind" text DEFAULT 'page' NOT NULL;--> statement-breakpoint
ALTER TABLE "shown_pages" ADD COLUMN "waiting_for_funds" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shown_showings" ADD COLUMN "kind" text DEFAULT 'page' NOT NULL;--> statement-breakpoint
ALTER TABLE "shown_showings" ADD COLUMN "reply_ref" uuid;--> statement-breakpoint
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_set_by_contributors_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_ended_by_contributors_id_fk" FOREIGN KEY ("ended_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_settings" ADD CONSTRAINT "gate_settings_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_set_by_contributors_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gates" ADD CONSTRAINT "gates_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_gate_settings_boundary" ON "gate_settings" USING btree ("boundary_id");--> statement-breakpoint
ALTER TABLE "showing_removals" ADD CONSTRAINT "showing_removals_made_by_contributors_id_fk" FOREIGN KEY ("made_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_showing_pages_item_version" ON "showing_pages" USING btree ("sensitivity_label","showing_id","version_key") WHERE node_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_showings_live_subject" ON "showings" USING btree ("sensitivity_label","boundary_id","kind","scope",COALESCE(subject_ref, '00000000-0000-0000-0000-000000000000'::uuid),COALESCE(payer_grant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE ended_at IS NULL AND node_id IS NULL;--> statement-breakpoint
ALTER TABLE "showing_pages" ADD CONSTRAINT "ck_showing_pages_kind" CHECK (CASE WHEN "showing_pages"."node_id" IS NULL THEN "showing_pages"."judgment_kind" IS NULL AND "showing_pages"."version_key" IS NOT NULL
               ELSE "showing_pages"."judgment_kind" IN ('assessment', 'quantity_estimate', 'question_assessment') AND "showing_pages"."judgment_id" IS NOT NULL END);--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "ck_showings_kind" CHECK ("showings"."kind" IN ('page', 'answer', 'taken_up', 'funding', 'mandate', 'message', 'petition', 'statement'));--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "ck_showings_subject" CHECK (CASE WHEN "showings"."scope" IN ('node', 'under') THEN "showings"."node_id" IS NOT NULL AND "showings"."kind" = 'page'
               WHEN "showings"."scope" = 'boundary' THEN "showings"."node_id" IS NULL AND "showings"."kind" = 'page'
               ELSE "showings"."node_id" IS NULL AND "showings"."subject_ref" IS NOT NULL END);--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "ck_showings_scope" CHECK ("showings"."scope" IN ('node', 'under', 'mandate', 'boundary', 'item'));--> statement-breakpoint
-- Hand-written from here: what existed before gates had settings is carried over.
--
-- Acts so far were a person's (an actor is named) or a standing rule's.
UPDATE "showing_acts" SET "by" = CASE WHEN "actor_id" IS NOT NULL THEN 'person' WHEN "rule_id" IS NOT NULL THEN 'setting' ELSE 'process' END;--> statement-breakpoint
-- One row for each gate that already exists, on the destination side. A
-- gate to outside keeps sending by hand unless a showing across it chose to
-- send as released.
INSERT INTO "gates" ("boundary_id", "send_as_released", "sensitivity_label")
SELECT p."boundary_id",
       CASE WHEN p."to_outside" THEN COALESCE((SELECT bool_or(s."send_as_released") FROM "shown_showings" s WHERE s."boundary_id" = p."boundary_id"), false) ELSE true END,
       COALESCE(p."to_label", 'public')
  FROM (SELECT DISTINCT "boundary_id", "to_label", "to_outside" FROM "redaction_policies" WHERE "side" = 'page') p
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- A gate that already exists was one where a person released each part, so
-- it keeps that as a setting its administrators can change. A gate made
-- after this starts from the Redactor's decision.
INSERT INTO "gate_settings" ("boundary_id", "kind", "scope", "mode", "from_rule", "sensitivity_label")
SELECT DISTINCT p."boundary_id", '*', 'boundary', 'person', 'as this gate worked before gates had settings', p."from_label"
  FROM "redaction_policies" p WHERE p."side" = 'page';--> statement-breakpoint
-- Each live release rule becomes that party's setting at its boundary.
-- "Release what rests on our material alone, whatever was removed" is the
-- Redactor's decision for that party's material. "Release it only where
-- nothing was removed" has no setting that does the same, and becomes a
-- person's decision, which releases nothing the party had not allowed.
INSERT INTO "gate_settings" ("boundary_id", "kind", "scope", "party_id", "mode", "set_by", "set_holding", "set_at", "from_rule", "sensitivity_label")
SELECT r."boundary_id", '*', 'boundary', r."party_id",
       CASE WHEN r."condition" = 'only_ours' THEN 'redactor' ELSE 'person' END,
       r."set_by", r."set_holding", r."set_at", r."condition" || ' (rule ' || r."id" || ')',
       (SELECT p."from_label" FROM "redaction_policies" p WHERE p."boundary_id" = r."boundary_id" AND p."side" = 'page' LIMIT 1)
  FROM "release_rules" r
 WHERE r."ended_at" IS NULL
   AND EXISTS (SELECT 1 FROM "redaction_policies" p WHERE p."boundary_id" = r."boundary_id" AND p."side" = 'page');--> statement-breakpoint
UPDATE "release_rules" SET "ended_at" = now() WHERE "ended_at" IS NULL;
