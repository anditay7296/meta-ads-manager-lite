CREATE TABLE "agent_alerts_seen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"ad_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"last_alerted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_alerts_seen" ADD CONSTRAINT "agent_alerts_seen_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_alerts_seen" ADD CONSTRAINT "agent_alerts_seen_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_alerts_seen" ADD CONSTRAINT "agent_alerts_seen_ad_id_ads_id_fk" FOREIGN KEY ("ad_id") REFERENCES "public"."ads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_alerts_seen_org_ad_kind_uq" ON "agent_alerts_seen" USING btree ("org_id","ad_id","kind");--> statement-breakpoint
CREATE INDEX "agent_alerts_seen_project_idx" ON "agent_alerts_seen" USING btree ("org_id","project_id");