ALTER TABLE "gate_settings" DROP CONSTRAINT "ck_gate_settings_kind";--> statement-breakpoint
ALTER TABLE "showings" DROP CONSTRAINT "ck_showings_kind";--> statement-breakpoint
ALTER TABLE "gate_settings" ADD CONSTRAINT "ck_gate_settings_kind" CHECK ("gate_settings"."kind" IN ('*', 'page', 'answer', 'taken_up', 'funding', 'mandate', 'message', 'petition', 'statement'));--> statement-breakpoint
ALTER TABLE "showings" ADD CONSTRAINT "ck_showings_kind" CHECK ("showings"."kind" IN ('page', 'answer', 'taken_up', 'funding', 'mandate', 'message', 'petition', 'statement'));--> statement-breakpoint
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
