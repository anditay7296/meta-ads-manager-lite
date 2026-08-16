CREATE TABLE "page_post_alerts_seen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"meta_post_id" text NOT NULL,
	"post_kind" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_boost_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"primary_ad_account_id" uuid NOT NULL,
	"primary_campaign_id" uuid NOT NULL,
	"primary_reference_ad_set_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"bootstrapped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_post_alerts_seen" ADD CONSTRAINT "page_post_alerts_seen_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_post_alerts_seen" ADD CONSTRAINT "page_post_alerts_seen_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boost_configs" ADD CONSTRAINT "project_boost_configs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boost_configs" ADD CONSTRAINT "project_boost_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boost_configs" ADD CONSTRAINT "project_boost_configs_primary_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("primary_ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boost_configs" ADD CONSTRAINT "project_boost_configs_primary_campaign_id_campaigns_id_fk" FOREIGN KEY ("primary_campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boost_configs" ADD CONSTRAINT "project_boost_configs_primary_reference_ad_set_id_ad_sets_id_fk" FOREIGN KEY ("primary_reference_ad_set_id") REFERENCES "public"."ad_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_post_alerts_seen_uq" ON "page_post_alerts_seen" USING btree ("org_id","page_id","meta_post_id");--> statement-breakpoint
CREATE INDEX "page_post_alerts_seen_org_idx" ON "page_post_alerts_seen" USING btree ("org_id","seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_boost_configs_project_uq" ON "project_boost_configs" USING btree ("project_id");