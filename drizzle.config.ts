import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "Set DATABASE_URL_DIRECT (Supabase direct connection, port 5432) for migrations.",
  );
}

export default {
  schema: "./lib/db/schema.ts",
  out: "./supabase/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  verbose: true,
  strict: true,
} satisfies Config;
