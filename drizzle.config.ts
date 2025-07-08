import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

// Load environment variables
config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
  schema: "./dist/db/schema/index.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
    ssl: false, // Always false as per requirement
  },
  // Share migrations with mythoria-webapp
  migrations: {
    table: 'drizzle_migrations',
    schema: 'public',
  },
});
