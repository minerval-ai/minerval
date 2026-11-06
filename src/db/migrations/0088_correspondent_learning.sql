CREATE TABLE "correspondent_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correspondent_id" uuid NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_correspondent_plan_items_status" CHECK ("correspondent_plan_items"."status" IN ('open', 'done', 'dropped'))
);
--> statement-breakpoint
CREATE TABLE "correspondent_practice_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"correspondent_id" uuid NOT NULL,
	"text" text NOT NULL,
	"reason" text NOT NULL,
	"revised_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "correspondents" ADD COLUMN "practice" text;--> statement-breakpoint
ALTER TABLE "correspondents" ADD COLUMN "practice_revised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "correspondent_plan_items" ADD CONSTRAINT "correspondent_plan_items_correspondent_id_correspondents_id_fk" FOREIGN KEY ("correspondent_id") REFERENCES "public"."correspondents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correspondent_practice_versions" ADD CONSTRAINT "correspondent_practice_versions_correspondent_id_correspondents_id_fk" FOREIGN KEY ("correspondent_id") REFERENCES "public"."correspondents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_correspondent_plan_items" ON "correspondent_plan_items" USING btree ("correspondent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_correspondent_practice_versions" ON "correspondent_practice_versions" USING btree ("correspondent_id","created_at");