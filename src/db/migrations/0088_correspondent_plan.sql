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
ALTER TABLE "correspondent_plan_items" ADD CONSTRAINT "correspondent_plan_items_correspondent_id_correspondents_id_fk" FOREIGN KEY ("correspondent_id") REFERENCES "public"."correspondents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_correspondent_plan_items" ON "correspondent_plan_items" USING btree ("correspondent_id","status","created_at");