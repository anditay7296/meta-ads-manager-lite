ALTER TABLE "copy_entries" ADD COLUMN "kind" text DEFAULT 'copy' NOT NULL;--> statement-breakpoint
ALTER TABLE "copy_entries" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "copy_entries" ADD COLUMN "source_ad_id" uuid;--> statement-breakpoint
ALTER TABLE "copy_entries" ADD COLUMN "source_board_item_id" uuid;--> statement-breakpoint
ALTER TABLE "copy_entries" ADD COLUMN "product_name" text;--> statement-breakpoint
ALTER TABLE "copy_entries" ADD COLUMN "visual_direction" text;--> statement-breakpoint
ALTER TABLE "copy_entries" ADD CONSTRAINT "copy_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_entries" ADD CONSTRAINT "copy_entries_source_ad_id_ads_id_fk" FOREIGN KEY ("source_ad_id") REFERENCES "public"."ads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copy_entries" ADD CONSTRAINT "copy_entries_source_board_item_id_board_items_id_fk" FOREIGN KEY ("source_board_item_id") REFERENCES "public"."board_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "copy_entries_kind_idx" ON "copy_entries" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX "copy_entries_project_idx" ON "copy_entries" USING btree ("project_id");