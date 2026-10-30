-- Search over requests (the /requests search box, list_requests' q), the
-- same hybrid as claims: an embedding of the ask and why, written by the
-- request service on filing and revision (scripts/backfill-request-
-- embeddings.ts fills existing rows), and a generated, weighted keyword
-- vector with its GIN index, which this migration fills itself.
ALTER TABLE "requests" ADD COLUMN "embedding" vector(1536);--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "text_search" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', "requests"."ask"), 'A')
        || setweight(to_tsvector('english', "requests"."why"), 'B')
        || setweight(to_tsvector('english', "requests"."satisfied_by"), 'C')
        || setweight(to_tsvector('english', coalesce("requests"."bears_on_text", '')), 'C')) STORED;--> statement-breakpoint
CREATE INDEX "idx_requests_text_search" ON "requests" USING gin ("text_search");
