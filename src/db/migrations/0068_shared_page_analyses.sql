CREATE TABLE "shared_page_analyses" (
	"url_hash" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"annotations" jsonb NOT NULL,
	"extracted" integer NOT NULL,
	"analyzed_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
