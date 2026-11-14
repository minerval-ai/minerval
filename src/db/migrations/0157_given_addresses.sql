CREATE TABLE "given_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"page_url_hash" text NOT NULL,
	"given_by" text NOT NULL,
	"given_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sensitivity_label" text DEFAULT minerval_default_label() NOT NULL,
	CONSTRAINT "ck_given_addresses_given_by" CHECK ("given_addresses"."given_by" IN ('search', 'page', 'listing', 'feed', 'identifier', 'person'))
);
--> statement-breakpoint
ALTER TABLE "given_addresses" ADD CONSTRAINT "given_addresses_sensitivity_label_labels_name_fk" FOREIGN KEY ("sensitivity_label") REFERENCES "public"."labels"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_given_addresses_page_label" ON "given_addresses" USING btree ("page_url_hash","sensitivity_label");