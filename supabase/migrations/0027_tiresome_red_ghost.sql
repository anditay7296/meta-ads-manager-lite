CREATE TABLE "project_boost_target_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_boost_config_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_boost_target_campaigns" ADD CONSTRAINT "project_boost_target_campaigns_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boost_target_campaigns" ADD CONSTRAINT "project_boost_target_campaigns_project_boost_config_id_project_boost_configs_id_fk" FOREIGN KEY ("project_boost_config_id") REFERENCES "public"."project_boost_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_boost_target_campaigns" ADD CONSTRAINT "project_boost_target_campaigns_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_boost_target_campaigns_uq" ON "project_boost_target_campaigns" USING btree ("project_boost_config_id","campaign_id");--> statement-breakpoint
DROP INDEX "page_post_alerts_seen_uq";--> statement-breakpoint
ALTER TABLE "page_post_alerts_seen" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "page_post_alerts_seen" ADD CONSTRAINT "page_post_alerts_seen_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "page_post_alerts_seen" AS ppas
SET "campaign_id" = pbc."primary_campaign_id"
FROM "pages" AS p
JOIN "project_boost_configs" AS pbc ON pbc."project_id" = p."project_id"
WHERE p."id" = ppas."page_id" AND ppas."campaign_id" IS NULL;--> statement-breakpoint
DELETE FROM "page_post_alerts_seen" WHERE "campaign_id" IS NULL;--> statement-breakpoint
ALTER TABLE "page_post_alerts_seen" ALTER COLUMN "campaign_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "page_post_alerts_seen_uq" ON "page_post_alerts_seen" USING btree ("org_id","page_id","meta_post_id","campaign_id");