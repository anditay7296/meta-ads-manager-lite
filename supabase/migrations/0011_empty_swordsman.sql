CREATE TABLE "whatsapp_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"wa_phone_number_id" text NOT NULL,
	"wa_business_account_id" text,
	"access_token_encrypted" "bytea" NOT NULL,
	"recipient_phone" text NOT NULL,
	"recipient_label" text,
	"verified_at" timestamp with time zone,
	"paired_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_paired_by_users_id_fk" FOREIGN KEY ("paired_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_connections_org_phone_uq" ON "whatsapp_connections" USING btree ("org_id","recipient_phone");--> statement-breakpoint
CREATE INDEX "whatsapp_connections_project_idx" ON "whatsapp_connections" USING btree ("org_id","project_id");