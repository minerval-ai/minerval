-- Keyword search over requests (the /requests search box, list_requests' q):
-- a generated, weighted tsvector over what a request asks and why, and its
-- GIN index. Generated, so every existing row is indexed by this migration.
ALTER TABLE "requests" ADD COLUMN "text_search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', "requests"."ask"), 'A')
        || setweight(to_tsvector('english', "requests"."why"), 'B')
        || setweight(to_tsvector('english', "requests"."satisfied_by"), 'C')
        || setweight(to_tsvector('english', coalesce("requests"."bears_on_text", '')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "idx_requests_text_search" ON "requests" USING gin ("text_search");
