ALTER TABLE "ad_creatives" ADD COLUMN "thumbnail_url" text;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD COLUMN "media_kind" text;--> statement-breakpoint
ALTER TABLE "ads" ADD COLUMN "meta_created_time" timestamp with time zone;