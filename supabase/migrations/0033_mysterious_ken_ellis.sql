CREATE TYPE "public"."clone_job_status" AS ENUM('queued', 'running', 'done', 'done_with_errors', 'failed');--> statement-breakpoint
CREATE TABLE "clone_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"source_meta_account_id" text NOT NULL,
	"source_campaign_id" uuid NOT NULL,
	"source_campaign_name" text NOT NULL,
	"dest_meta_account_id" text NOT NULL,
	"dest_campaign_id" uuid NOT NULL,
	"dest_campaign_name" text NOT NULL,
	"dest_account_name" text NOT NULL,
	"status" "clone_job_status" DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"cloned" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"per_ad_set" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggered_by" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "is_restricted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "restricted_detected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clone_jobs" ADD CONSTRAINT "clone_jobs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clone_jobs" ADD CONSTRAINT "clone_jobs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clone_jobs_org_status_idx" ON "clone_jobs" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "clone_jobs_org_created_idx" ON "clone_jobs" USING btree ("org_id","created_at");