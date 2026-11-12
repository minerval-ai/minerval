ALTER TABLE "assistant_pages" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "assistant_pages" ADD CONSTRAINT "assistant_pages_share_token_unique" UNIQUE("share_token");