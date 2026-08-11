CREATE TABLE "claim_instance_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"support" text DEFAULT 'unclear' NOT NULL,
	"deployment" text,
	"note" text,
	"quote_check" text DEFAULT 'no_stored_content' NOT NULL,
	"worth_reading" boolean DEFAULT false NOT NULL,
	"worth_reading_reason" text,
	"source_read" boolean DEFAULT false NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_provenance_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"from_instance_id" uuid NOT NULL,
	"to_source_id" uuid NOT NULL,
	"to_instance_id" uuid,
	"relation_type" text NOT NULL,
	"fidelity" text DEFAULT 'unclear' NOT NULL,
	"evidence" text NOT NULL,
	"reasoning" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"created_by" text DEFAULT 'source_mapper' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claim_source_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"material" boolean DEFAULT false NOT NULL,
	"sources_considered" integer DEFAULT 0 NOT NULL,
	"sources_read" integer DEFAULT 0 NOT NULL,
	"edges_recorded" integer DEFAULT 0 NOT NULL,
	"model" text,
	"mapped_by" text DEFAULT 'source_mapper' NOT NULL,
	"mapped_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_source_id" uuid NOT NULL,
	"child_source_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"reasoning" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"created_by" text DEFAULT 'source_mapper' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sr_no_self_reference" CHECK ("source_relationships"."parent_source_id" != "source_relationships"."child_source_id")
);
--> statement-breakpoint
ALTER TABLE "claim_instance_readings" ADD CONSTRAINT "claim_instance_readings_instance_id_claim_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."claim_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_instance_readings" ADD CONSTRAINT "claim_instance_readings_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_provenance_edges" ADD CONSTRAINT "claim_provenance_edges_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_provenance_edges" ADD CONSTRAINT "claim_provenance_edges_from_instance_id_claim_instances_id_fk" FOREIGN KEY ("from_instance_id") REFERENCES "public"."claim_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_provenance_edges" ADD CONSTRAINT "claim_provenance_edges_to_source_id_sources_id_fk" FOREIGN KEY ("to_source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_provenance_edges" ADD CONSTRAINT "claim_provenance_edges_to_instance_id_claim_instances_id_fk" FOREIGN KEY ("to_instance_id") REFERENCES "public"."claim_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_source_maps" ADD CONSTRAINT "claim_source_maps_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relationships" ADD CONSTRAINT "source_relationships_parent_source_id_sources_id_fk" FOREIGN KEY ("parent_source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_relationships" ADD CONSTRAINT "source_relationships_child_source_id_sources_id_fk" FOREIGN KEY ("child_source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cir_instance" ON "claim_instance_readings" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "idx_cir_claim" ON "claim_instance_readings" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_cpe_unique" ON "claim_provenance_edges" USING btree ("from_instance_id","to_source_id","relation_type");--> statement-breakpoint
CREATE INDEX "idx_cpe_claim" ON "claim_provenance_edges" USING btree ("claim_id");--> statement-breakpoint
CREATE INDEX "idx_cpe_to_source" ON "claim_provenance_edges" USING btree ("to_source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_csm_claim" ON "claim_source_maps" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_sr_unique" ON "source_relationships" USING btree ("parent_source_id","child_source_id","relation_type");--> statement-breakpoint
CREATE INDEX "idx_sr_parent" ON "source_relationships" USING btree ("parent_source_id");--> statement-breakpoint
CREATE INDEX "idx_sr_child" ON "source_relationships" USING btree ("child_source_id");