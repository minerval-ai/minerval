ALTER TABLE "sources" ADD COLUMN "page_url_hash" text;--> statement-breakpoint
CREATE INDEX "idx_sources_page_url_hash" ON "sources" USING btree ("page_url_hash");