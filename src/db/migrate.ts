import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDatabase } from './connection.js';
import { logger } from '@/config/logger.js';

async function runMigrations(): Promise<void> {
  try {
    logger.info('Starting database migrations...');
    const db = getDatabase();
    
    // Use shared migrations from mythoria-webapp
    await migrate(db, { migrationsFolder: '../mythoria-webapp/drizzle' });
    
    logger.info('✅ Database migrations completed successfully');
  } catch (error) {
    logger.error('❌ Database migration failed:', error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
}
