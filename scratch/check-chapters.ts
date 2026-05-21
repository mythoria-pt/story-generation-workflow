import pkg from 'pg';
const { Client } = pkg;
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function checkChapters() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  await client.connect();
  const storyId = '2967e0a4-07f9-4989-861a-90637b339fa4';
  const res = await client.query('SELECT count(*) FROM chapters WHERE story_id = $1', [storyId]);
  console.log('Chapters count:', res.rows[0].count);
  await client.end();
}

checkChapters().catch(console.error);
