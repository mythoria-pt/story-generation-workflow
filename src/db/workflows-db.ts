import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as workflowsSchema from "./workflows-schema/index.js";

let workflowsPool: Pool | null = null;
let workflowsDb: ReturnType<typeof drizzle> | null = null;

export function getWorkflowsDatabase() {
  if (!workflowsDb) {
    workflowsPool = new Pool({
      host: process.env.DB_HOST!,
      port: parseInt(process.env.DB_PORT || '5432'),
      user: process.env.DB_USER!,
      password: process.env.DB_PASSWORD!,
      database: process.env.WORKFLOWS_DB_NAME!,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    workflowsDb = drizzle(workflowsPool, { 
      schema: workflowsSchema,
      logger: process.env.NODE_ENV === 'development'
    });
  }

  return workflowsDb;
}

export function closeWorkflowsDatabaseConnection(): Promise<void> {
  if (workflowsPool) {
    return workflowsPool.end();
  }
  return Promise.resolve();
}

// Export schema for use in other files
export * from "./workflows-schema/index.js";
