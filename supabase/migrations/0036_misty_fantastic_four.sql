CREATE TABLE "inngest_usage_monthly" (
	"month" text PRIMARY KEY NOT NULL,
	"execution_count" bigint DEFAULT 0 NOT NULL,
	"last_alerted_threshold" integer
);
