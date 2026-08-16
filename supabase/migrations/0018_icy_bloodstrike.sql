ALTER TABLE "campaigns" ADD COLUMN "auto_pause_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "auto_pause_exempt_reason" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "auto_pause_exempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "auto_pause_exempt_by" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_auto_pause_exempt_by_users_id_fk" FOREIGN KEY ("auto_pause_exempt_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;