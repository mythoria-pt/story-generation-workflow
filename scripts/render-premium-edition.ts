import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { PremiumAsset } from '../src/services/premium-book-contract.js';

async function main() {
  const [manifestPath, assetsDir, outputDir, qrPath] = process.argv.slice(2);
  if (!manifestPath || !assetsDir || !outputDir || !qrPath) {
    throw new Error(
      'Usage: tsx scripts/render-premium-edition.ts <manifest.json> <asset-dir> <new-output-dir> <specification-qr.png>',
    );
  }

  // The shared renderer imports the service logger, which validates runtime configuration.
  // This offline command supplies local placeholders and reads all assets from disk.
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_HOST: '127.0.0.1',
    DB_PORT: '5432',
    DB_USER: 'local',
    DB_PASSWORD: 'local',
    DB_NAME: 'unused',
    GOOGLE_CLOUD_PROJECT_ID: 'local-print-preview',
    GOOGLE_CLOUD_REGION: 'us-central1',
    STORAGE_BUCKET_NAME: 'unused-local-print-preview',
  });
  const { renderSquarePdf, validatePremiumManifest } =
    await import('../src/services/premium-order-proof.js');
  const { printQrUrl } = await import('../src/services/print.js');
  const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  const { storyId, revision } = z.object({ storyId: z.uuid(), revision: z.uuid() }).parse(value);
  const book = validatePremiumManifest(value, storyId, revision);
  const loadArt = async (ref: PremiumAsset) => {
    const file = basename(ref.key);
    const bytes = await readFile(join(assetsDir, file));
    if (
      bytes.length !== ref.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== ref.sha256
    ) {
      throw new Error(`Local premium asset differs from its pin: ${file}`);
    }
    return bytes;
  };
  const qr = await readFile(qrPath);
  const loadBrand = async (url: string) => {
    if (url !== printQrUrl) throw new Error('Unknown premium brand asset');
    return { bytes: qr, contentType: 'image/png' };
  };
  await mkdir(outputDir);
  const interior = await renderSquarePdf(book, outputDir, 'interior', loadArt, loadBrand);
  const cover = await renderSquarePdf(book, outputDir, 'cover', loadArt, loadBrand);
  const issues = [...new Set([...interior.issues, ...cover.issues])];
  process.stdout.write(
    JSON.stringify({ pageCount: book.format.pageCount, outputDir, issues }) + '\n',
  );
  if (issues.length > 0) process.exitCode = 1;
}

main().catch((error: Error) => {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
