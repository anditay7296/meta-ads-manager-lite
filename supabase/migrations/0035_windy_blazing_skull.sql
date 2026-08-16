CREATE TABLE "cron_heartbeats" (
	"function_id" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL,
	"last_alerted_at" timestamp with time zone
);
