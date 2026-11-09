CREATE TABLE "setup_parts" (
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"source_path" text,
	"first_seen_commit" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_parts_kind_name_hash_pk" PRIMARY KEY("kind","name","hash"),
	CONSTRAINT "ck_setup_parts_kind" CHECK ("setup_parts"."kind" IN ('constitution', 'role', 'tool'))
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "commit_sha" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_setup_parts_version" ON "setup_parts" USING btree ("kind","name","version");