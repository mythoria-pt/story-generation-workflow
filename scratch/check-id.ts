import pkg from 'pg';
const { Client } = pkg;
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function checkIdInRuns() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  await client.connect();
  const id = '2967e0a4-07f9-4989-861a-90637b339fa4';

  console.log('Checking in runs table...');
  const resRun = await client.query('SELECT * FROM runs WHERE run_id = $1', [id]);
  console.log('Run count:', resRun.rowCount);
  if (resRun.rowCount > 0) {
    console.log('Run found for story:', resRun.rows[0].story_id);
  }

  console.log('Checking in stories table...');
  const resStory = await client.query('SELECT * FROM stories WHERE story_id = $1', [id]);
  console.log('Story count:', resStory.rowCount);
  if (resStory.rowCount > 0) {
    console.log('Story found:', resStory.rows[0].title);
  }

  await client.end();
}

checkIdInRuns().catch(console.error);
