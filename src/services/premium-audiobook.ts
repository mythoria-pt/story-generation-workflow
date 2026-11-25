import { z } from 'zod';
import {
  premiumAsset,
  premiumRevisionPrefix,
  type PremiumManifest,
} from './premium-book-contract.js';

export const premiumAudioTrack = z.object({
  pageNumber: z.number().int().min(5).max(32),
  audio: premiumAsset,
  duration: z.number().positive(),
});

export function premiumNarrationPages(book: Pick<PremiumManifest, 'pages'>) {
  return book.pages.filter(
    ({ kind, text }) =>
      (kind === 'opener' || kind === 'spread' || kind === 'ending') && text.trim().length > 0,
  );
}

export function premiumAudiobookPrefix(storyId: string, revision: string, runId: string) {
  return `${premiumRevisionPrefix(storyId, revision)}/audiobooks/${z.uuid().parse(runId)}`;
}
