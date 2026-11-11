ALTER TABLE "sources" DROP CONSTRAINT "sources_content_hash_unique";--> statement-breakpoint
CREATE INDEX "idx_sources_content_hash" ON "sources" USING btree ("content_hash");--> statement-breakpoint
-- Every source that already holds its text gets the hash of that text: the
-- same value services/source-content.ts computes when text is stored.
UPDATE "sources"
   SET "content_hash" = encode(sha256(convert_to("raw_content", 'UTF8')), 'hex')
 WHERE "raw_content" IS NOT NULL AND "raw_content" <> '';
