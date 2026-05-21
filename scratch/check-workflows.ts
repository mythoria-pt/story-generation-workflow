import pkg from 'pg';
const { Client } = pkg;
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function checkIdInWorkflows() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.WORKFLOWS_DB,
  });

  await client.connect();
  const id = '2967e0a4-07f9-4989-861a-90637b339fa4';
  
  console.log('Checking in story_generation_runs table...');
  const resRun = await client.query('SELECT * FROM story_generation_runs WHERE run_id = $1', [id]);
  console.log('Run count:', resRun.rowCount);
  if (resRun.rowCount > 0) {
    console.log('Run found for story:', resRun.rows[0].story_id);
  } else {
    console.log('ID not found in story_generation_runs as run_id');
    const resStoryRef = await client.query('SELECT * FROM story_generation_runs WHERE story_id = $1', [id]);
    console.log('Story ref count in runs:', resStoryRef.rowCount);
    if (resStoryRef.rowCount > 0) {
        console.log('Story ref found in runs, run_id:', resStoryRef.rows[0].run_id);
    }
  }

  await client.end();
}

checkIdInWorkflows().catch(console.error);
