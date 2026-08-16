CREATE TABLE "agent_preference_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"week_start" timestamp with time zone NOT NULL,
	"summary_text" text NOT NULL,
	"proposals_approved" integer DEFAULT 0 NOT NULL,
	"proposals_rejected" integer DEFAULT 0 NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_preference_summaries" ADD CONSTRAINT "agent_preference_summaries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_preference_summaries" ADD CONSTRAINT "agent_preference_summaries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_pref_summary_org_project_week_uq" ON "agent_preference_summaries" USING btree ("org_id","project_id","week_start");--> statement-breakpoint
CREATE INDEX "agent_pref_summary_recent_idx" ON "agent_preference_summaries" USING btree ("org_id","project_id","created_at");