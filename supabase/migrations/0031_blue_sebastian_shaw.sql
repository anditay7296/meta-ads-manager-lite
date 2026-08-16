CREATE TABLE "webinar_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"event_date" date NOT NULL,
	"webinar_name" text NOT NULL,
	"source_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webinar_reports_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "webinar_reports" ADD CONSTRAINT "webinar_reports_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webinar_reports" ADD CONSTRAINT "webinar_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webinar_reports_org_idx" ON "webinar_reports" USING btree ("org_id");