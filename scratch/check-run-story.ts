import pkg from 'pg';
const { Client } = pkg;
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function checkStoryIdForRun() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.WORKFLOWS_DB,
  });

  await client.connect();
  const runId = '7818a3ac-4b35-40df-9e1c-3e14f8b8f6a5';
  const res = await client.query('SELECT story_id FROM story_generation_runs WHERE run_id = $1', [runId]);
  if (res.rowCount > 0) {
    console.log('Story ID for run:', res.rows[0].story_id);
  } else {
    console.log('Run not found');
  }
  await client.end();
}

checkStoryIdForRun().catch(console.error);
