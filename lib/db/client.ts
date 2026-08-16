import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Use the Supabase project's pooled connection string (port 6543).",
  );
}

const queryClient = postgres(url, {
  prepare: false, // Supabase pooler (transaction mode) requires this
  max: 10,
  idle_timeout: 20,
});

export const db = drizzle(queryClient, { schema });
export type DB = typeof db;
export { schema };
