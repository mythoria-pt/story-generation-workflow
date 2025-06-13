import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getDatabaseConfig } from '@/config/database.js';
import * as schema from './schema/index.js';

let pool: Pool | null = null;
let db: ReturnType<typeof drizzle> | null = null;

export function getDatabase() {
  if (!db) {
    const config = getDatabaseConfig();
    
    pool = new Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      ssl: config.ssl ? (typeof config.ssl === 'object' ? config.ssl : { rejectUnauthorized: false }) : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    db = drizzle(pool, { schema });
  }

  return db;
}

export function closeDatabaseConnection(): Promise<void> {
  if (pool) {
    return pool.end();
  }
  return Promise.resolve();
}

export { schema };
