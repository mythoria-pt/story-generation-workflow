import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getWorkflowsDatabase } from './workflows-db.js';
import { logger } from '@/config/logger.js';

async function runWorkflowsMigrations(): Promise<void> {
  try {
    logger.info('Starting workflows database migrations...');
    const db = getWorkflowsDatabase();
    
    // Use dedicated workflows migrations
    await migrate(db, { migrationsFolder: './drizzle-workflows' });
    
    logger.info('✅ Workflows database migrations completed successfully');
  } catch (error) {
    logger.error('❌ Workflows database migration failed:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  runWorkflowsMigrations();
}
