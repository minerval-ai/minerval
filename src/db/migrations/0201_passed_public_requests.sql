CREATE TABLE "passed_public_requests" (
	"public_request_id" uuid PRIMARY KEY NOT NULL,
	"passed_by" uuid,
	"passed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "passed_public_requests" ADD CONSTRAINT "passed_public_requests_passed_by_contributors_id_fk" FOREIGN KEY ("passed_by") REFERENCES "public"."contributors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passed_public_requests" ADD CONSTRAINT "passed_public_requests_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;