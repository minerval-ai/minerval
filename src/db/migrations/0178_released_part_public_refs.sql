-- A released part names the nodes it cites that the public graph holds, by
-- their public ids (#1157; docs/releasing-a-page.md, "The parts of a page").
-- release_parts.public_refs is fixed when the page is recorded and covered by
-- the part's commitment under the construction "minerval-released-page/3";
-- received_parts.public_refs is copied with the part's text when it is
-- released and is null while the part is held. Pages recorded from now on
-- are fingerprinted under /3. A page already recorded keeps the construction
-- its row names, and every check rebuilds it under that one.
ALTER TABLE "received_pages" ALTER COLUMN "fingerprint_format" SET DEFAULT 'minerval-released-page/3';--> statement-breakpoint
ALTER TABLE "release_pages" ALTER COLUMN "fingerprint_format" SET DEFAULT 'minerval-released-page/3';--> statement-breakpoint
ALTER TABLE "received_parts" ADD COLUMN "public_refs" uuid[];--> statement-breakpoint
ALTER TABLE "release_parts" ADD COLUMN "public_refs" uuid[] DEFAULT '{}' NOT NULL;