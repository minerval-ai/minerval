-- An arXiv paper cited by its full-text HTML or its PDF had no author, date
-- or publisher: those two renderings carry no metadata, and the facts lookup
-- read only the page it was given. It now reads the paper's abstract page
-- (factsPageUrl in src/services/source-facts-service.ts). Clearing
-- facts_checked_at on the sources that lookup left empty has the source
-- backfill's sweep take each once more; facts are fill-only, so nothing
-- already recorded changes.
UPDATE "sources" SET "facts_checked_at" = NULL
 WHERE "url" ~* '^https?://(www\.)?arxiv\.org/(html|pdf)/'
   AND "facts_checked_at" IS NOT NULL
   AND ("published_date" IS NULL OR "authors" IS NULL OR cardinality("authors") = 0);
