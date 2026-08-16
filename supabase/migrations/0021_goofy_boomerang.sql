ALTER TABLE "decision_journal" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "decision_journal" ADD CONSTRAINT "decision_journal_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_project_time_idx" ON "decision_journal" USING btree ("project_id","occurred_at");--> statement-breakpoint
UPDATE "decision_journal" dj
SET "project_id" = aa."project_id"
FROM "ads" a
JOIN "ad_sets" s ON s."id" = a."ad_set_id"
JOIN "campaigns" c ON c."id" = s."campaign_id"
JOIN "ad_accounts" aa ON aa."id" = c."ad_account_id"
WHERE dj."project_id" IS NULL
  AND dj."entity_kind" = 'ad'
  AND dj."entity_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND a."id" = dj."entity_id"::uuid;--> statement-breakpoint

UPDATE "decision_journal" dj
SET "project_id" = aa."project_id"
FROM "ad_sets" s
JOIN "campaigns" c ON c."id" = s."campaign_id"
JOIN "ad_accounts" aa ON aa."id" = c."ad_account_id"
WHERE dj."project_id" IS NULL
  AND dj."entity_kind" IN ('ad_set','adset')
  AND dj."entity_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND s."id" = dj."entity_id"::uuid;--> statement-breakpoint

UPDATE "decision_journal" dj
SET "project_id" = aa."project_id"
FROM "campaigns" c
JOIN "ad_accounts" aa ON aa."id" = c."ad_account_id"
WHERE dj."project_id" IS NULL
  AND dj."entity_kind" = 'campaign'
  AND dj."entity_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND c."id" = dj."entity_id"::uuid;--> statement-breakpoint

UPDATE "decision_journal" dj
SET "project_id" = COALESCE(p."project_id", ig."project_id")
FROM "posts" po
LEFT JOIN "pages" p ON p."id" = po."page_id"
LEFT JOIN "ig_accounts" ig ON ig."id" = po."ig_account_id"
WHERE dj."project_id" IS NULL
  AND dj."entity_kind" IN ('post','story')
  AND dj."entity_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND po."id" = dj."entity_id"::uuid;--> statement-breakpoint

-- The page-post-watch cron stores Meta post IDs (numeric) as entity_id and the
-- internal page UUID in metadata.pageId — derive the project via that path.
UPDATE "decision_journal" dj
SET "project_id" = COALESCE(p."project_id", ig."project_id")
FROM "decision_journal" d
LEFT JOIN "pages" p ON p."id" = NULLIF(d."metadata"->>'pageId', '')::uuid
LEFT JOIN "ig_accounts" ig ON ig."id" = NULLIF(d."metadata"->>'igAccountId', '')::uuid
WHERE dj."id" = d."id"
  AND dj."project_id" IS NULL
  AND dj."entity_kind" IN ('post','story');--> statement-breakpoint

UPDATE "decision_journal" dj
SET "project_id" = COALESCE(r."applies_to_project_id", aa."project_id")
FROM "automated_rules" r
LEFT JOIN "ad_accounts" aa ON aa."id" = r."applies_to_ad_account_id"
WHERE dj."project_id" IS NULL
  AND dj."entity_kind" = 'rule'
  AND dj."entity_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND r."id" = dj."entity_id"::uuid;--> statement-breakpoint

UPDATE "decision_journal" dj
SET "project_id" = dj."entity_id"::uuid
WHERE dj."project_id" IS NULL
  AND dj."entity_kind" = 'project'
  AND dj."entity_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND EXISTS (SELECT 1 FROM "projects" p WHERE p."id" = dj."entity_id"::uuid);