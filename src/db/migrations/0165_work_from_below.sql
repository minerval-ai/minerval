CREATE TABLE "label_faces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"for_label" text NOT NULL,
	"name" text NOT NULL,
	"can_be_asked" text NOT NULL,
	"written_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_label_faces_not_own" CHECK ("label_faces"."for_label" <> "label_faces"."sensitivity_label")
);
--> statement-breakpoint
ALTER TABLE "adopted_requests" ADD COLUMN "grant_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "asked_of_face_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "asked_as" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "asked_budget_micro_usd" bigint;--> statement-breakpoint
ALTER TABLE "label_faces" ADD CONSTRAINT "label_faces_for_label_labels_name_fk" FOREIGN KEY ("for_label") REFERENCES "public"."labels"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_faces" ADD CONSTRAINT "label_faces_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_label_faces_for_at" ON "label_faces" USING btree ("for_label","sensitivity_label");--> statement-breakpoint
ALTER TABLE "adopted_requests" ADD CONSTRAINT "adopted_requests_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_asked_of_face_id_label_faces_id_fk" FOREIGN KEY ("asked_of_face_id") REFERENCES "public"."label_faces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_adopted_requests_grant" ON "adopted_requests" USING btree ("grant_id");--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "ck_requests_asked_as" CHECK ("requests"."asked_as" IS NULL OR "requests"."asked_as" IN ('work', 'mandate'));