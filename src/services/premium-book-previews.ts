import type { Bucket } from '@google-cloud/storage';
import { z } from 'zod';
import { premiumAsset, type PremiumManifest } from './premium-book-contract.js';
import {
  readPremiumObject,
  savePremiumImage,
  stagePremiumCheckpoint,
} from './premium-book-storage.js';
import { renderSquarePagePreviews, loadPremiumPublicationQr } from './premium-order-proof.js';

const previewSet = z.array(z.object({ number: z.number().int(), image: premiumAsset }));

export async function addPremiumPagePreviews(
  bucket: Bucket,
  prefix: string,
  book: PremiumManifest,
) {
  const pages = book.pages.filter(({ reading }) => !reading);
  if (pages.length === 0) return;
  const previews = await stagePremiumCheckpoint(
    bucket,
    `${prefix}/checkpoints/reading-page-previews.json`,
    previewSet,
    async () => {
      const captures = await renderSquarePagePreviews(
        book,
        pages,
        (asset) => readPremiumObject(bucket, asset),
        loadPremiumPublicationQr,
      );
      return Promise.all(
        pages.map(async (page, index) => {
          const capture = captures[index];
          if (!capture) throw new Error('Missing premium reading preview');
          return {
            number: page.number,
            image: await savePremiumImage(bucket, prefix, capture, 'png'),
          };
        }),
      );
    },
  );
  if (previews.length !== pages.length) throw new Error('Incomplete premium reading previews');
  for (const [index, page] of pages.entries()) {
    const preview = previews[index];
    if (!preview || preview.number !== page.number)
      throw new Error('Unexpected premium preview page order');
    page.reading = preview.image;
  }
}
