import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";
import { getDatabaseConfig } from "./src/config/database.js";

// Load environment variables
config({ path: ".env.local" });
config({ path: ".env" });

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: (() => {
    const dbConfig = getDatabaseConfig();
    return {
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      ssl: typeof dbConfig.ssl === 'object' ? dbConfig.ssl : dbConfig.ssl ? { rejectUnauthorized: false } : false,
    };
  })(),
  // Share migrations with mythoria-webapp
  migrations: {
    table: 'drizzle_migrations',
    schema: 'public',
  },
});
