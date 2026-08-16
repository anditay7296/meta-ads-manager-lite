CREATE TABLE "telegram_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"chat_id" text NOT NULL,
	"chat_title" text,
	"chat_type" text,
	"paired_by" uuid NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_actions" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
ALTER TABLE "agent_actions" ADD COLUMN "telegram_message_id" text;--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD COLUMN "telegram_message_id" text;--> statement-breakpoint
ALTER TABLE "insights_daily" ADD COLUMN "purchases" bigint;--> statement-breakpoint
ALTER TABLE "insights_daily" ADD COLUMN "web_purchases" bigint;--> statement-breakpoint
ALTER TABLE "insights_daily" ADD COLUMN "conversion_value" numeric(18, 4);--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_paired_by_users_id_fk" FOREIGN KEY ("paired_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_connections_org_chat_uq" ON "telegram_connections" USING btree ("org_id","chat_id");--> statement-breakpoint
CREATE INDEX "telegram_connections_project_idx" ON "telegram_connections" USING btree ("org_id","project_id");