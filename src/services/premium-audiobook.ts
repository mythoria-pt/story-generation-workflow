import type { Bucket } from '@google-cloud/storage';
import { z } from 'zod';
import { concatenateAudioBuffers, measureAudioDurationSeconds } from './audio-concatenation.js';
import {
  PremiumBookError,
  premiumAsset,
  premiumRevisionPrefix,
  type PremiumManifest,
} from './premium-book-contract.js';
import {
  premiumDigest,
  readPremiumCheckpoint,
  readPremiumObject,
  savePremiumObject,
  stagePremiumCheckpoint,
  withPremiumLease,
} from './premium-book-storage.js';

const MAX_AUDIOBOOK_BYTES = 16 * 1024 * 1024;

export const premiumAudioTrack = z.object({
  pageNumber: z.number().int().min(5).max(32),
  audio: premiumAsset,
  duration: z.number().positive(),
});

const premiumAudioFile = z.object({
  audio: premiumAsset.extend({ bytes: z.number().int().positive().max(MAX_AUDIOBOOK_BYTES) }),
  duration: z.number().positive(),
});

const audiobookIdentity = z.object({
  type: z.literal('premium_children'),
  revision: z.uuid(),
  runId: z.uuid(),
});

export const premiumAudiobook = z.union([
  audiobookIdentity.extend(premiumAudioFile.shape),
  audiobookIdentity.extend({ tracks: z.array(premiumAudioTrack) }),
]);

const premiumAudiobookAssembly = premiumAudioFile.extend({
  parts: z.array(premiumAudioTrack).min(1).max(28),
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

export const premiumAudiobookFileKey = (prefix: string, digest: string) =>
  `${prefix}/audiobook-${digest}.mp3`;

export const premiumAudiobookPageCheckpoint = (prefix: string, pageNumber: number) =>
  `${prefix}/page-${pageNumber}.json`;

export const premiumAudiobookPageKey = (prefix: string, pageNumber: number, digest: string) =>
  `${prefix}/page-${pageNumber}-${digest}.mp3`;

export async function assemblePremiumAudiobook(
  bucket: Bucket,
  prefix: string,
  pageNumbers: number[],
) {
  const checkpoint = `${prefix}/audiobook.json`;
  const assembly = await withPremiumLease(bucket, checkpoint, () =>
    stagePremiumCheckpoint(bucket, checkpoint, premiumAudiobookAssembly, async () => {
      const parts = await Promise.all(
        pageNumbers.map(async (pageNumber) => {
          const track = await readPremiumCheckpoint(
            bucket,
            premiumAudiobookPageCheckpoint(prefix, pageNumber),
            premiumAudioTrack,
          );
          if (
            !track ||
            track.pageNumber !== pageNumber ||
            track.audio.key !== premiumAudiobookPageKey(prefix, pageNumber, track.audio.sha256)
          ) {
            throw new PremiumBookError(
              409,
              'premium_audiobook_incomplete',
              'Audiobook incomplete for the requested edition',
            );
          }
          return { track, bytes: await readPremiumObject(bucket, track.audio) };
        }),
      );
      const { buffer } = await concatenateAudioBuffers(
        parts.map(({ bytes }) => bytes),
        {
          normalizeStreams: true,
        },
      );
      const duration = await measureAudioDurationSeconds(buffer);
      if (!duration || buffer.length > MAX_AUDIOBOOK_BYTES) {
        throw new PremiumBookError(
          422,
          'premium_audiobook_invalid_audio',
          'Audiobook assembly did not produce playable audio within the size limit',
        );
      }
      const audio = await savePremiumObject(
        bucket,
        premiumAudiobookFileKey(prefix, premiumDigest(buffer)),
        buffer,
        'audio/mpeg',
      );
      return { audio, duration, parts: parts.map(({ track }) => track) };
    }),
  );
  if (assembly.audio.key !== premiumAudiobookFileKey(prefix, assembly.audio.sha256)) {
    throw new PremiumBookError(409, 'premium_audiobook_invalid_audio', 'Invalid audiobook key');
  }
  await readPremiumObject(bucket, assembly.audio);
  return assembly;
}

export async function removePremiumAudiobookParts(
  bucket: Bucket,
  prefix: string,
  parts: z.infer<typeof premiumAudioTrack>[],
) {
  return Promise.allSettled(
    parts.map(async ({ pageNumber, audio }) => {
      if (audio.key !== premiumAudiobookPageKey(prefix, pageNumber, audio.sha256)) return;
      await bucket
        .file(audio.key)
        .delete({ ifGenerationMatch: audio.generation, ignoreNotFound: true });
    }),
  );
}
