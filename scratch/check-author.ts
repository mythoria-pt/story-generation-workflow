import pkg from 'pg';
const { Client } = pkg;
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

async function checkAuthor() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  await client.connect();
  const authorId = 'e41e9a58-a5ce-411d-852c-68fd92e230f8';
  const res = await client.query('SELECT count(*) FROM authors WHERE author_id = $1', [authorId]);
  console.log('Author count:', res.rows[0].count);
  await client.end();
}

checkAuthor().catch(console.error);
