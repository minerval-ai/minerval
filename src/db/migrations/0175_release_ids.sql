-- A showing is a release, and a party's release of a part is its consent
-- (docs/releasing-a-page.md, "Old names in the code"). The tables, columns,
-- indexes and constraints of a release take the new names, and the stored
-- values the code reads take theirs. Renaming keeps every row, every grant
-- on a table, every trigger and every row-level security policy, which
-- belong to the table and not to its name. The destination side's tables
-- keep `shown_`: they are named for what their readers are shown, held
-- parts included.
--
-- Words recorded as they were said are not rewritten: the permissions a
-- person held when they acted (`holding`, "release for <party>"), the words
-- of a gate's setting stamped on what it let through (`released_under`),
-- the text of a page that arrived as a source, a saved version of a
-- redaction policy, and every package already signed. The web app says the
-- old words in the new ones where it shows them (web/lib/stored-words.ts).
ALTER TABLE "showings" RENAME TO "releases";--> statement-breakpoint
ALTER TABLE "showing_pages" RENAME TO "release_pages";--> statement-breakpoint
ALTER TABLE "showing_parts" RENAME TO "release_parts";--> statement-breakpoint
ALTER TABLE "showing_removals" RENAME TO "release_removals";--> statement-breakpoint
ALTER TABLE "showing_acts" RENAME TO "release_acts";--> statement-breakpoint
ALTER TABLE "shown_showings" RENAME TO "shown_releases";--> statement-breakpoint
ALTER TABLE "release_rules" RENAME TO "consent_rules";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "showings_pkey" TO "releases_pkey";--> statement-breakpoint
ALTER TABLE "release_pages" RENAME CONSTRAINT "showing_pages_pkey" TO "release_pages_pkey";--> statement-breakpoint
ALTER TABLE "release_parts" RENAME CONSTRAINT "showing_parts_pkey" TO "release_parts_pkey";--> statement-breakpoint
ALTER TABLE "release_removals" RENAME CONSTRAINT "showing_removals_pkey" TO "release_removals_pkey";--> statement-breakpoint
ALTER TABLE "release_acts" RENAME CONSTRAINT "showing_acts_pkey" TO "release_acts_pkey";--> statement-breakpoint
ALTER TABLE "shown_releases" RENAME CONSTRAINT "shown_showings_pkey" TO "shown_releases_pkey";--> statement-breakpoint
ALTER TABLE "consent_rules" RENAME CONSTRAINT "release_rules_pkey" TO "consent_rules_pkey";--> statement-breakpoint
ALTER TABLE "release_pages" RENAME COLUMN "showing_id" TO "release_id";--> statement-breakpoint
ALTER TABLE "release_acts" RENAME COLUMN "showing_id" TO "release_id";--> statement-breakpoint
ALTER TABLE "shown_nodes" RENAME COLUMN "showing_id" TO "release_id";--> statement-breakpoint
ALTER TABLE "shown_pages" RENAME COLUMN "showing_id" TO "release_id";--> statement-breakpoint
ALTER TABLE "outbound_packages" RENAME COLUMN "showing_id" TO "release_id";--> statement-breakpoint
ALTER TABLE "outbound_proposals" RENAME COLUMN "showing_id" TO "release_id";--> statement-breakpoint
ALTER TABLE "published_pages" RENAME COLUMN "showing_id" TO "release_id";--> statement-breakpoint
ALTER TABLE "inbound_contributions" RENAME COLUMN "showing_id" TO "release_id";--> statement-breakpoint
ALTER TABLE "outbound_proposals" RENAME COLUMN "releases" TO "consents";--> statement-breakpoint
ALTER INDEX "uq_published_pages_showing_node" RENAME TO "uq_published_pages_release_node";--> statement-breakpoint
ALTER INDEX "idx_release_rules_boundary" RENAME TO "idx_consent_rules_boundary";--> statement-breakpoint
ALTER TABLE "consent_rules" RENAME CONSTRAINT "release_rules_ended_by_contributors_id_fk" TO "consent_rules_ended_by_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "consent_rules" RENAME CONSTRAINT "release_rules_party_id_parties_id_fk" TO "consent_rules_party_id_parties_id_fk";--> statement-breakpoint
ALTER TABLE "consent_rules" RENAME CONSTRAINT "release_rules_sensitivity_label_labels_name_fk" TO "consent_rules_sensitivity_label_labels_name_fk";--> statement-breakpoint
ALTER TABLE "consent_rules" RENAME CONSTRAINT "release_rules_set_by_contributors_id_fk" TO "consent_rules_set_by_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "consent_rules" RENAME CONSTRAINT "ck_release_rules_condition" TO "ck_consent_rules_condition";--> statement-breakpoint
ALTER INDEX "idx_showing_acts_item" RENAME TO "idx_release_acts_item";--> statement-breakpoint
ALTER INDEX "idx_showing_acts_showing" RENAME TO "idx_release_acts_release";--> statement-breakpoint
ALTER TABLE "release_acts" RENAME CONSTRAINT "showing_acts_actor_id_contributors_id_fk" TO "release_acts_actor_id_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "release_acts" RENAME CONSTRAINT "showing_acts_party_id_parties_id_fk" TO "release_acts_party_id_parties_id_fk";--> statement-breakpoint
ALTER TABLE "release_acts" RENAME CONSTRAINT "showing_acts_sensitivity_label_labels_name_fk" TO "release_acts_sensitivity_label_labels_name_fk";--> statement-breakpoint
ALTER INDEX "idx_showing_pages_stage" RENAME TO "idx_release_pages_stage";--> statement-breakpoint
ALTER INDEX "uq_showing_pages_item_version" RENAME TO "uq_release_pages_item_version";--> statement-breakpoint
ALTER INDEX "uq_showing_pages_version" RENAME TO "uq_release_pages_version";--> statement-breakpoint
ALTER TABLE "release_pages" RENAME CONSTRAINT "showing_pages_node_id_claims_id_fk" TO "release_pages_node_id_claims_id_fk";--> statement-breakpoint
ALTER TABLE "release_pages" RENAME CONSTRAINT "showing_pages_sensitivity_label_labels_name_fk" TO "release_pages_sensitivity_label_labels_name_fk";--> statement-breakpoint
ALTER TABLE "release_pages" RENAME CONSTRAINT "showing_pages_showing_id_showings_id_fk" TO "release_pages_release_id_releases_id_fk";--> statement-breakpoint
ALTER TABLE "release_pages" RENAME CONSTRAINT "ck_showing_pages_kind" TO "ck_release_pages_kind";--> statement-breakpoint
ALTER TABLE "release_pages" RENAME CONSTRAINT "ck_showing_pages_stage" TO "ck_release_pages_stage";--> statement-breakpoint
ALTER INDEX "uq_showing_parts_position" RENAME TO "uq_release_parts_position";--> statement-breakpoint
ALTER TABLE "release_parts" RENAME CONSTRAINT "showing_parts_page_id_showing_pages_id_fk" TO "release_parts_page_id_release_pages_id_fk";--> statement-breakpoint
ALTER TABLE "release_parts" RENAME CONSTRAINT "showing_parts_sensitivity_label_labels_name_fk" TO "release_parts_sensitivity_label_labels_name_fk";--> statement-breakpoint
ALTER INDEX "idx_showing_removals_part" RENAME TO "idx_release_removals_part";--> statement-breakpoint
ALTER TABLE "release_removals" RENAME CONSTRAINT "showing_removals_made_by_contributors_id_fk" TO "release_removals_made_by_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "release_removals" RENAME CONSTRAINT "showing_removals_part_id_showing_parts_id_fk" TO "release_removals_part_id_release_parts_id_fk";--> statement-breakpoint
ALTER TABLE "release_removals" RENAME CONSTRAINT "showing_removals_sensitivity_label_labels_name_fk" TO "release_removals_sensitivity_label_labels_name_fk";--> statement-breakpoint
ALTER TABLE "release_removals" RENAME CONSTRAINT "ck_showing_removals_span" TO "ck_release_removals_span";--> statement-breakpoint
ALTER INDEX "idx_showings_node" RENAME TO "idx_releases_node";--> statement-breakpoint
ALTER INDEX "uq_showings_live" RENAME TO "uq_releases_live";--> statement-breakpoint
ALTER INDEX "uq_showings_live_subject" RENAME TO "uq_releases_live_subject";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "showings_asked_by_contributors_id_fk" TO "releases_asked_by_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "showings_ended_by_contributors_id_fk" TO "releases_ended_by_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "showings_node_id_claims_id_fk" TO "releases_node_id_claims_id_fk";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "showings_sensitivity_label_labels_name_fk" TO "releases_sensitivity_label_labels_name_fk";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "showings_to_label_labels_name_fk" TO "releases_to_label_labels_name_fk";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "ck_showings_destination" TO "ck_releases_destination";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "ck_showings_form" TO "ck_releases_form";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "ck_showings_kind" TO "ck_releases_kind";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "ck_showings_not_own_label" TO "ck_releases_not_own_label";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "ck_showings_scope" TO "ck_releases_scope";--> statement-breakpoint
ALTER TABLE "releases" RENAME CONSTRAINT "ck_showings_subject" TO "ck_releases_subject";--> statement-breakpoint
ALTER INDEX "idx_shown_nodes_showing" RENAME TO "idx_shown_nodes_release";--> statement-breakpoint
ALTER INDEX "idx_shown_pages_showing" RENAME TO "idx_shown_pages_release";--> statement-breakpoint
ALTER INDEX "idx_shown_showings_node" RENAME TO "idx_shown_releases_node";--> statement-breakpoint
ALTER TABLE "shown_releases" RENAME CONSTRAINT "shown_showings_asked_by_contributors_id_fk" TO "shown_releases_asked_by_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "shown_releases" RENAME CONSTRAINT "shown_showings_ended_by_contributors_id_fk" TO "shown_releases_ended_by_contributors_id_fk";--> statement-breakpoint
ALTER TABLE "shown_releases" RENAME CONSTRAINT "shown_showings_sensitivity_label_labels_name_fk" TO "shown_releases_sensitivity_label_labels_name_fk";--> statement-breakpoint
-- The permission to consent for one party was stored as `release`.
ALTER TABLE "permission_grants" DROP CONSTRAINT "ck_permission_grants_permission";--> statement-breakpoint
ALTER TABLE "permission_grants" DROP CONSTRAINT "ck_permission_grants_party_scope";--> statement-breakpoint
UPDATE "permission_grants" SET "permission" = 'consent' WHERE "permission" = 'release';--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "ck_permission_grants_permission" CHECK ("permission_grants"."permission" IN ('direct', 'consent', 'fund', 'read', 'read_sources', 'administer', 'clear_providers'));--> statement-breakpoint
ALTER TABLE "permission_grants" ADD CONSTRAINT "ck_permission_grants_party_scope" CHECK (("permission_grants"."party_id" IS NOT NULL) = ("permission_grants"."permission" = 'consent'));--> statement-breakpoint
-- A party's consent at a gate was recorded as the act `released`.
UPDATE "release_acts" SET "act" = 'consented' WHERE "act" = 'released';--> statement-breakpoint
-- A node that left a release because the release ended.
UPDATE "shown_nodes" SET "left_reason" = 'release_ended' WHERE "left_reason" = 'showing_ended';--> statement-breakpoint
-- The words a node is proposed to the public graph in, while they wait for the parties' consent.
ALTER TABLE "outbound_proposals" DROP CONSTRAINT "ck_outbound_proposals_state";--> statement-breakpoint
ALTER TABLE "outbound_proposals" ALTER COLUMN "state" SET DEFAULT 'waiting_for_consent';--> statement-breakpoint
UPDATE "outbound_proposals" SET "state" = 'waiting_for_consent' WHERE "state" = 'waiting_for_release';--> statement-breakpoint
ALTER TABLE "outbound_proposals" ADD CONSTRAINT "ck_outbound_proposals_state" CHECK ("outbound_proposals"."state" IN ('waiting_for_consent', 'ready', 'sent', 'on_the_public_graph', 'not_admitted', 'replaced'));--> statement-breakpoint
-- A released page arriving at a label is a source of the kind released_page. Its address,
-- minerval:shown-page/<shown_pages.id>/<n>, names the destination side's row and is kept.
ALTER TABLE "sources" DROP CONSTRAINT "ck_sources_source_type";--> statement-breakpoint
UPDATE "sources" SET "source_type" = 'released_page' WHERE "source_type" = 'shown_page';--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "ck_sources_source_type" CHECK ("sources"."source_type" IN ('dataset', 'official_statistics', 'transcript', 'treaty', 'court_record', 'legislation', 'journal_article', 'preprint', 'conference_paper', 'book', 'book_chapter', 'thesis', 'report', 'standard', 'news_article', 'opinion', 'press_release', 'blog_post', 'social_media_post', 'reference_work', 'broadcast', 'webpage', 'released_page', 'published_page', 'unknown'));--> statement-breakpoint
-- What a release attached to a node as a source, and detached when a later arrival replaced it.
UPDATE "claim_instances" SET "created_by" = 'release' WHERE "created_by" = 'showing';--> statement-breakpoint
UPDATE "claim_instances" SET "detached_by" = 'release' WHERE "detached_by" = 'showing';--> statement-breakpoint
-- This function names release_pages in its body, which is kept as text, so it is written again.
CREATE OR REPLACE FUNCTION minerval_only_shown_pages_between(
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
          SELECT 1 FROM public.shown_pages sp
            JOIN public.release_pages pp ON pp.id = sp.id
           WHERE sp.source_id = d.source_id
             AND pp.sensitivity_label = ANY (public.minerval_labels_readable_from(ARRAY[reader_label]))))
$$;
