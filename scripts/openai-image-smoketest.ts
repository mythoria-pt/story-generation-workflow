import OpenAI, { toFile } from 'openai';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables from .env.local first, then .env
dotenv.config({ path: path.resolve('.env.local') });
dotenv.config({ path: path.resolve('.env') });

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }

  const [promptArg, ...imageArgs] = process.argv.slice(2);
  const prompt = promptArg || 'A calm riverside village at sunrise, storybook illustration';
  const imagePaths = imageArgs;

  if (imagePaths.length === 0) {
    throw new Error(
      'Provide at least one image path: npx tsx scripts/openai-image-smoketest.ts "prompt" path/to/img1.jpg [img2...]',
    );
  }

  const client = new OpenAI({ apiKey });
  const files = await Promise.all(
    imagePaths.map((p) => {
      const abs = path.resolve(p);
      const filename = path.basename(abs);
      const ext = path.extname(filename).toLowerCase();
      const mime =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : 'image/webp';
      const stream = fs.createReadStream(abs);
      return toFile(stream, filename, { type: mime });
    }),
  );

  const response = await client.images.edit({
    model: 'gpt-image-1.5',
    prompt,
    image: files,
    size: '1024x1536',
    quality: 'high',
    n: 1,
  });

  const first = response.data?.[0];
  if (!first?.b64_json) {
    throw new Error('No base64 image returned');
  }

  const outputPath = path.resolve('openai-image-output.png');
  fs.writeFileSync(outputPath, Buffer.from(first.b64_json, 'base64'));
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
