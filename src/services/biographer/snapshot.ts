import { z } from 'zod';
import { proposalOutput, historyTurn } from './contract.js';

export const BIOGRAPHER_STORY_MARKER = '[MYTHORIA_BIOGRAPHER_V1]';
export const generationSnapshot = proposalOutput.extend({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  revision: z.number().int(),
  persona: z.string().min(1),
  personaVersion: z.number().int().positive(),
  effectivePersonaGuidance: z.string().min(1),
  referenceImages: z
    .array(
      z.object({
        objectPath: z.string().min(1),
        mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        participantId: z.string().uuid(),
        caption: z.string().optional(),
      }),
    )
    .default([]),
  research: z.array(z.object({ url: z.string().url(), title: z.string(), text: z.string() })),
  turns: z.array(historyTurn.extend({ id: z.string().uuid() })),
});
export type GenerationSnapshot = z.infer<typeof generationSnapshot>;
export async function loadBiographerSnapshot(storyId: string, additionalRequests?: string) {
  if (!additionalRequests?.includes(BIOGRAPHER_STORY_MARKER)) return null;
  if (!process.env.BIOGRAPHER_WEBAPP_URL || !process.env.BIOGRAPHER_INTERNAL_API_KEY)
    throw new Error('Biographer source access unavailable');
  const response = await fetch(
    new URL('/api/biographer/internal/snapshot', process.env.BIOGRAPHER_WEBAPP_URL),
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.BIOGRAPHER_INTERNAL_API_KEY,
      },
      body: JSON.stringify({ storyId }),
    },
  );
  if (!response.ok) throw new Error('Approved Biographer source snapshot unavailable');
  const body: unknown = await response.json();
  return validateGenerationSnapshot(body);
}
export function validateGenerationSnapshot(body: unknown) {
  const snapshot = generationSnapshot.parse(body);
  const sources = new Set(
    snapshot.turns.filter((turn) => turn.role === 'user').map((turn) => turn.id),
  );
  const covered = new Set(snapshot.chapters.flatMap((chapter) => chapter.sourceTurnIds));
  const omitted = new Set(snapshot.omittedSources.map((source) => source.id));
  if (
    snapshot.targetWords > snapshot.chapters.length * 2000 ||
    snapshot.chapters.some(
      (chapter, index) =>
        chapter.number !== index + 1 || chapter.sourceTurnIds.some((id) => !sources.has(id)),
    ) ||
    omitted.size !== snapshot.omittedSources.length ||
    [...omitted].some((id) => !sources.has(id) || covered.has(id)) ||
    [...sources].some((id) => !covered.has(id) && !omitted.has(id))
  )
    throw new Error('Invalid approved Biographer source coverage');
  return snapshot;
}
/** Source selection fails closed rather than silently dropping anecdote detail or inventing an ID. */
export function chapterEvidence(snapshot: GenerationSnapshot, number: number) {
  const chapter = snapshot.chapters.find((item) => item.number === number);
  if (!chapter) throw new Error('Chapter missing from approved proposal');
  const ids = new Set(chapter.sourceTurnIds);
  const turns = snapshot.turns.filter((turn) => turn.role === 'user' && ids.has(turn.id));
  if (turns.length !== ids.size) throw new Error('Approved source turns missing');
  return {
    chapter,
    turns,
    research: snapshot.research,
    persona: snapshot.persona,
    targetWords: Math.round(snapshot.targetWords / snapshot.chapters.length),
  };
}
export function approvedOutline(snapshot: GenerationSnapshot) {
  const illustration =
    'Generated illustration inspired by the supplied memory references; transform appearance and scene coherently with the approved narrative and graphical style. Never insert original photographs.';
  return {
    bookTitle: snapshot.title,
    'target-audience': 'adult_18+',
    synopses: snapshot.synopsis,
    bookCoverPrompt: `${illustration} Book title: ${snapshot.title}. ${snapshot.synopsis}`,
    bookBackCoverPrompt: `${illustration} Complementary back cover for ${snapshot.title}.`,
    bookCoverCharacters: [],
    bookBackCoverCharacters: [],
    characters: [],
    chapters: snapshot.chapters.map((chapter) => ({
      chapterNumber: chapter.number,
      chapterTitle: chapter.title,
      chapterSynopses: chapter.synopsis,
      chapterPhotoPrompt: `${illustration} ${chapter.title}: ${chapter.synopsis}`,
      charactersInScene: [],
    })),
  };
}
