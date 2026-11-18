-- The receiving side of a release, and the names left from showing a page
-- (docs/releasing-a-page.md, "Old names in the code"). The destination
-- side's tables are named for what that side holds, a held part as well as
-- a released one: shown_releases, shown_nodes, shown_pages and shown_parts
-- become received_releases, received_nodes, received_pages and
-- received_parts; a page's shown_at, when it went through to that side, is
-- released_at; and gates.backlog_shown is backlog_visible. Renaming keeps
-- each table's rows, grants, triggers and row-level security policies.
--
-- A page's fingerprint is made under a construction its record now names
-- (fingerprint_format): pages recorded from now on under
-- minerval-released-page/2, and every page recorded before under
-- minerval-shown-page/1, which their roots, their headers and every package
-- that carries them were made with. Those are fixed by a hash or a
-- signature and are not rewritten; neither are the sources already made, a
-- saved version of a redaction policy, or a signed package. Words kept as
-- plain text are: the permissions a person held, and the words of a gate's
-- setting stamped on what it let through.
ALTER TABLE "shown_releases" RENAME TO "received_releases";--> statement-breakpoint
ALTER TABLE "shown_nodes" RENAME TO "received_nodes";--> statement-breakpoint
ALTER TABLE "shown_pages" RENAME TO "received_pages";--> statement-breakpoint
ALTER TABLE "shown_parts" RENAME TO "received_parts";--> statement-breakpoint
ALTER TABLE "received_releases" RENAME CONSTRAINT "shown_releases_pkey" TO "received_releases_pkey";--> statement-breakpoint
ALTER TABLE "received_nodes" RENAME CONSTRAINT "shown_nodes_pkey" TO "received_nodes_pkey";--> statement-breakpoint
ALTER TABLE "received_pages" RENAME CONSTRAINT "shown_pages_pkey" TO "received_pages_pkey";--> statement-breakpoint
ALTER TABLE "received_parts" RENAME CONSTRAINT "shown_parts_pkey" TO "received_parts_pkey";--> statement-breakpoint
ALTER TABLE "received_pages" RENAME COLUMN "shown_at" TO "released_at";--> statement-breakpoint
ALTER TABLE "gates" RENAME COLUMN "backlog_shown" TO "backlog_visible";--> statement-breakpoint
ALTER INDEX "idx_shown_nodes_node" RENAME TO "idx_received_nodes_node";--> statement-breakpoint
ALTER INDEX "idx_shown_nodes_release" RENAME TO "idx_received_nodes_release";--> statement-breakpoint
ALTER TABLE "received_nodes" RENAME CONSTRAINT "shown_nodes_sensitivity_label_labels_name_fk" TO "received_nodes_sensitivity_label_labels_name_fk";--> statement-breakpoint
ALTER INDEX "idx_shown_pages_release" RENAME TO "idx_received_pages_release";--> statement-breakpoint
ALTER TABLE "received_pages" RENAME CONSTRAINT "shown_pages_sensitivity_label_labels_name_fk" TO "received_pages_sensitivity_label_labels_name_fk";--> statement-breakpoint
ALTER INDEX "uq_shown_parts_position" RENAME TO "uq_received_parts_position";--> statement-breakpoint
ALTER TABLE "received_parts" RENAME CONSTRAINT "shown_parts_sensitivity_label_labels_name_fk" TO "received_parts_sensitivity_label_labels_name_fk";--> statement-breakpoint
ALTER INDEX "idx_shown_releases_node" RENAME TO "idx_received_releases_node";--> statement-breakpoint
ALTER TABLE "received_releases" RENAME CONSTRAINT "shown_releases_asked_by_contributors_id_fk" TO "received_releases_asked_by_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "received_releases" RENAME CONSTRAINT "shown_releases_ended_by_contributors_id_fk" TO "received_releases_ended_by_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "received_releases" RENAME CONSTRAINT "shown_releases_sensitivity_label_labels_name_fk" TO "received_releases_sensitivity_label_labels_name_fk";--> statement-breakpoint
-- The construction each page's fingerprint is made under: the old one for every page recorded until now.
ALTER TABLE "release_pages" ADD COLUMN "fingerprint_format" text DEFAULT 'minerval-shown-page/1' NOT NULL;--> statement-breakpoint
ALTER TABLE "release_pages" ALTER COLUMN "fingerprint_format" SET DEFAULT 'minerval-released-page/2';--> statement-breakpoint
ALTER TABLE "received_pages" ADD COLUMN "fingerprint_format" text DEFAULT 'minerval-shown-page/1' NOT NULL;--> statement-breakpoint
ALTER TABLE "received_pages" ALTER COLUMN "fingerprint_format" SET DEFAULT 'minerval-released-page/2';--> statement-breakpoint
-- The function that reads released pages takes their name, and names received_pages in its body.
DROP FUNCTION IF EXISTS minerval_only_shown_pages_between(text, uuid, uuid, text);--> statement-breakpoint
CREATE OR REPLACE FUNCTION minerval_only_released_pages_between(
  kind text, old_version uuid, new_version uuid, reader_label text
) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  WITH old_in AS (
    SELECT input_kind, node_id, relation_type, input_judgment_id, input_label, source_id
      FROM public.judgment_inputs WHERE judgment_kind = kind AND judgment_id = old_version
  ), new_in AS (
    SELECT input_kind, node_id, relation_type, input_judgment_id, input_label, source_id
      FROM public.judgment_inputs WHERE judgment_kind = kind AND judgment_id = new_version
  ), other_diff AS (
    (SELECT input_kind, node_id, relation_type, input_judgment_id, input_label FROM old_in WHERE input_kind <> 'source'
     EXCEPT
     SELECT input_kind, node_id, relation_type, input_judgment_id, input_label FROM new_in WHERE input_kind <> 'source')
    UNION ALL
    (SELECT input_kind, node_id, relation_type, input_judgment_id, input_label FROM new_in WHERE input_kind <> 'source'
     EXCEPT
     SELECT input_kind, node_id, relation_type, input_judgment_id, input_label FROM old_in WHERE input_kind <> 'source')
  ), source_diff AS (
    (SELECT source_id FROM old_in WHERE input_kind = 'source' EXCEPT SELECT source_id FROM new_in WHERE input_kind = 'source')
    UNION ALL
    (SELECT source_id FROM new_in WHERE input_kind = 'source' EXCEPT SELECT source_id FROM old_in WHERE input_kind = 'source')
  )
  SELECT new_version IS NOT NULL AND old_version IS NOT NULL
     AND EXISTS (SELECT 1 FROM old_in)
     AND NOT EXISTS (SELECT 1 FROM other_diff)
     AND EXISTS (SELECT 1 FROM source_diff)
     AND NOT EXISTS (
       SELECT 1 FROM source_diff d
        WHERE NOT EXISTS (
          SELECT 1 FROM public.received_pages sp
            JOIN public.release_pages pp ON pp.id = sp.id
           WHERE sp.source_id = d.source_id
             AND pp.sensitivity_label = ANY (public.minerval_labels_readable_from(ARRAY[reader_label]))))
$$;
--> statement-breakpoint
-- The permissions a person held when they acted, kept as words: "release for <party>" is "consent for <party>".
CREATE FUNCTION pg_temp.consent_words(holding text[]) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(CASE WHEN h LIKE 'release for %' THEN 'consent for ' || substr(h, 13) WHEN h = 'release' THEN 'consent' ELSE h END ORDER BY n), '{}'::text[])
    FROM unnest(holding) WITH ORDINALITY AS u(h, n)
$$;--> statement-breakpoint
UPDATE "releases" SET "asked_holding" = pg_temp.consent_words("asked_holding") WHERE 'release' = ANY("asked_holding") OR EXISTS (SELECT 1 FROM unnest("asked_holding") h WHERE h LIKE 'release for %');--> statement-breakpoint
UPDATE "releases" SET "ended_holding" = pg_temp.consent_words("ended_holding") WHERE 'release' = ANY("ended_holding") OR EXISTS (SELECT 1 FROM unnest("ended_holding") h WHERE h LIKE 'release for %');--> statement-breakpoint
UPDATE "received_releases" SET "asked_holding" = pg_temp.consent_words("asked_holding") WHERE 'release' = ANY("asked_holding") OR EXISTS (SELECT 1 FROM unnest("asked_holding") h WHERE h LIKE 'release for %');--> statement-breakpoint
UPDATE "received_releases" SET "ended_holding" = pg_temp.consent_words("ended_holding") WHERE 'release' = ANY("ended_holding") OR EXISTS (SELECT 1 FROM unnest("ended_holding") h WHERE h LIKE 'release for %');--> statement-breakpoint
UPDATE "release_acts" SET "holding" = pg_temp.consent_words("holding") WHERE 'release' = ANY("holding") OR EXISTS (SELECT 1 FROM unnest("holding") h WHERE h LIKE 'release for %');--> statement-breakpoint
UPDATE "gate_settings" SET "set_holding" = pg_temp.consent_words("set_holding") WHERE 'release' = ANY("set_holding") OR EXISTS (SELECT 1 FROM unnest("set_holding") h WHERE h LIKE 'release for %');--> statement-breakpoint
UPDATE "consent_rules" SET "set_holding" = pg_temp.consent_words("set_holding") WHERE 'release' = ANY("set_holding") OR EXISTS (SELECT 1 FROM unnest("set_holding") h WHERE h LIKE 'release for %');--> statement-breakpoint
UPDATE "outbound_proposals" SET "written_holding" = pg_temp.consent_words("written_holding") WHERE 'release' = ANY("written_holding") OR EXISTS (SELECT 1 FROM unnest("written_holding") h WHERE h LIKE 'release for %');--> statement-breakpoint
UPDATE "outbound_sends" SET "holding" = pg_temp.consent_words("holding") WHERE 'release' = ANY("holding") OR EXISTS (SELECT 1 FROM unnest("holding") h WHERE h LIKE 'release for %');--> statement-breakpoint
UPDATE "outward_acts" SET "holding" = pg_temp.consent_words("holding") WHERE 'release' = ANY("holding") OR EXISTS (SELECT 1 FROM unnest("holding") h WHERE h LIKE 'release for %');--> statement-breakpoint
UPDATE "outbound_proposals" SET "consents" = (
  SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(c->'holding') = 'array'
                                 THEN jsonb_set(c, '{holding}', to_jsonb(pg_temp.consent_words(ARRAY(SELECT jsonb_array_elements_text(c->'holding')))))
                                 ELSE c END ORDER BY n), '[]'::jsonb)
    FROM jsonb_array_elements("consents") WITH ORDINALITY AS e(c, n))
  WHERE jsonb_typeof("consents") = 'array' AND "consents"::text LIKE '%"release%';--> statement-breakpoint
-- The words of a gate's setting stamped on what it let through, as GATE_MODES now says them.
UPDATE "received_pages" SET "released_under" = replace("released_under"::text,
    'the people who hold release for the parties it rests on', 'the people who consent for the parties it rests on')::jsonb
  WHERE "released_under"::text LIKE '%the people who hold release for the parties it rests on%';--> statement-breakpoint
-- A Steward's reassessment opened because a released page arrived, and its sender, as they are recorded.
UPDATE "node_messages" SET "trigger" = 'page_released' WHERE "trigger" = 'page_shown';--> statement-breakpoint
UPDATE "node_messages" SET "sender_ref" = 'released:' || substr("sender_ref", 7) WHERE "sender_ref" LIKE 'shown:%';--> statement-breakpoint
UPDATE "mandate_inbox" SET "target_ref" = 'released:' || substr("target_ref", 7) WHERE "target_ref" LIKE 'shown:%';--> statement-breakpoint
UPDATE "enqueue_events" SET "trigger" = 'page_released' WHERE "trigger" = 'page_shown';--> statement-breakpoint
UPDATE "examinations" SET "trigger" = 'page_released' WHERE "trigger" = 'page_shown';--> statement-breakpoint
UPDATE "assessments" SET "trigger" = 'page_released' WHERE "trigger" = 'page_shown' AND "origin" <> 'mirror';--> statement-breakpoint
UPDATE "quantity_estimates" SET "trigger" = 'page_released' WHERE "trigger" = 'page_shown' AND "origin" <> 'mirror';--> statement-breakpoint
UPDATE "question_assessments" SET "trigger" = 'page_released' WHERE "trigger" = 'page_shown' AND "origin" <> 'mirror';--> statement-breakpoint
UPDATE "artifact_assessments" SET "trigger" = 'page_released' WHERE "trigger" = 'page_shown' AND "origin" <> 'mirror';
