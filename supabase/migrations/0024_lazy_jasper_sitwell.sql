CREATE TABLE "competitor_ad_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"archive_id" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitor_brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"meta_page_id" text,
	"search_terms" text[] DEFAULT '{}'::text[] NOT NULL,
	"countries" text[] DEFAULT '{"MY"}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_snapshotted_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competitor_ad_snapshots" ADD CONSTRAINT "competitor_ad_snapshots_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_ad_snapshots" ADD CONSTRAINT "competitor_ad_snapshots_brand_id_competitor_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."competitor_brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_brands" ADD CONSTRAINT "competitor_brands_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_brands" ADD CONSTRAINT "competitor_brands_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitor_brands" ADD CONSTRAINT "competitor_brands_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competitor_snapshots_brand_archive_uq" ON "competitor_ad_snapshots" USING btree ("brand_id","archive_id");--> statement-breakpoint
CREATE INDEX "competitor_snapshots_brand_seen_idx" ON "competitor_ad_snapshots" USING btree ("brand_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "competitor_brands_org_project_idx" ON "competitor_brands" USING btree ("org_id","project_id");