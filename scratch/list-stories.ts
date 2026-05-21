import pkg from 'pg';
const { Client } = pkg;
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function listStories() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  await client.connect();
  const res = await client.query('SELECT story_id, author_id, title FROM stories LIMIT 10');
  console.log('Stories found:', res.rowCount);
  res.rows.forEach(row => {
    console.log(`Story ID: ${row.story_id}, Author ID: ${row.author_id}, Title: ${row.title}`);
  });
  await client.end();
}

listStories().catch(console.error);
