import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as workflowsSchema from './workflows-schema/index.js';

let workflowsPool: Pool | null = null;
let workflowsDb: ReturnType<typeof drizzle> | null = null;

export function getWorkflowsDatabase() {
  if (!workflowsDb) {
    // Validate required environment variables
    const host = process.env.DB_HOST;
    const user = process.env.DB_USER;
    const password = process.env.DB_PASSWORD;
    const database = process.env.WORKFLOWS_DB;

    if (!host || !user || !password || !database) {
      throw new Error(
        'Missing required database environment variables: DB_HOST, DB_USER, DB_PASSWORD, WORKFLOWS_DB',
      );
    }

    workflowsPool = new Pool({
      host,
      port: parseInt(process.env.DB_PORT || '5432'),
      user,
      password,
      database,
      ssl: false, // Always false as per requirement
      max: 15, // Increased from 10 to handle more concurrent operations
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000, // Increased from 2000ms to 10000ms
    });

    workflowsDb = drizzle(workflowsPool, {
      schema: workflowsSchema,
      logger: process.env.NODE_ENV === 'development',
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
export * from './workflows-schema/index.js';
