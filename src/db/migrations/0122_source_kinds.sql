-- One list of source kinds (SOURCE_KIND_DESCRIPTIONS in
-- src/schemas/common.ts). The column was free text with three vocabularies
-- around it; anything outside the list says nothing a reader can use, so it
-- becomes "unknown" and the next agent or lookup to see the source names it.
UPDATE "sources" SET "source_type" = 'unknown'
 WHERE "source_type" NOT IN ('dataset', 'official_statistics', 'transcript', 'treaty', 'court_record', 'legislation', 'journal_article', 'preprint', 'conference_paper', 'book', 'book_chapter', 'thesis', 'report', 'standard', 'news_article', 'opinion', 'press_release', 'blog_post', 'social_media_post', 'reference_work', 'broadcast', 'webpage', 'unknown');--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "ck_sources_source_type" CHECK ("sources"."source_type" IN ('dataset', 'official_statistics', 'transcript', 'treaty', 'court_record', 'legislation', 'journal_article', 'preprint', 'conference_paper', 'book', 'book_chapter', 'thesis', 'report', 'standard', 'news_article', 'opinion', 'press_release', 'blog_post', 'social_media_post', 'reference_work', 'broadcast', 'webpage', 'unknown'));
