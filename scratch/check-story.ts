import pkg from 'pg';
const { Client } = pkg;
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function checkStory() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  await client.connect();
  const storyId = '2967e0a4-07f9-4989-861a-90637b339fa4';
  const res = await client.query('SELECT * FROM stories WHERE story_id = $1', [storyId]);
  console.log('Story count:', res.rowCount);
  if (res.rowCount > 0) {
    console.log('Story found:', res.rows[0].title);
  } else {
    console.log('Story NOT found');
  }
  await client.end();
}

checkStory().catch(console.error);
