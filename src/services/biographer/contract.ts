import { z } from 'zod';

export const biographerLocale = z.enum(['en-US', 'pt-PT', 'es-ES', 'fr-FR', 'de-DE']);
export const historyTurn = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().max(40000),
  contributorName: z.string().max(200).optional(),
  participantId: z.string().uuid().optional(),
});
export const projectContext = z.object({
  projectTitle: z.string().max(500).optional(),
  storyBrief: z.string().max(40000).optional(),
  characterNames: z.array(z.string().max(200)).max(50).optional(),
  subject: z.string().max(1000).optional(),
  purpose: z.string().max(2000).optional(),
  places: z.array(z.string().max(200)).max(20).optional(),
  photoCaptions: z.array(z.string().max(2000)).max(20).optional(),
  period: z.string().max(200).optional(),
  relationship: z.string().max(500).optional(),
  followUps: z.array(z.string().max(1000)).max(5).optional(),
  sharedMemories: z
    .array(
      z.object({
        sourceId: z.string().uuid(),
        contributorName: z.string().max(200),
        text: z.string().max(2000),
      }),
    )
    .max(30)
    .optional(),
});
export const interviewRequest = z.object({
  authorId: z.string().uuid(),
  projectId: z.string().uuid(),
  locale: biographerLocale,
  history: z
    .array(historyTurn)
    .max(300)
    .refine(
      (turns) => turns.reduce((sum, turn) => sum + turn.text.length, 0) <= 400000,
      'Interview context exceeds supported budget',
    ),
  context: projectContext,
  userText: z.string().max(40000).optional(),
  photoReferences: z
    .array(
      z.object({
        objectPath: z.string().max(1024),
        contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        participantId: z.string().uuid(),
      }),
    )
    .max(3)
    .optional(),
});
export const proposalRequest = interviewRequest.extend({
  turns: z.array(historyTurn.extend({ id: z.string().uuid() })).max(1000),
  persona: z.string().max(80).optional(),
  targetWords: z.number().int().min(1000).max(20000).default(20000),
});
export const chapterProposal = z.object({
  number: z.number().int().positive().max(20),
  title: z.string().min(1).max(300),
  synopsis: z.string().min(1).max(4000),
  sourceTurnIds: z.array(z.string().uuid()).min(1).max(1000),
});
export const proposalOutput = z.object({
  title: z.string().min(1).max(500),
  synopsis: z.string().min(1).max(8000),
  chapters: z.array(chapterProposal).min(1).max(20),
  targetWords: z.number().int().min(1000).max(20000),
  omittedSources: z
    .array(z.object({ id: z.string().uuid(), reason: z.string().min(1).max(500) }))
    .max(1000),
});
export type InterviewRequest = z.infer<typeof interviewRequest>;
export type ProposalRequest = z.infer<typeof proposalRequest>;
export function requireBiographer(): void {
  if (process.env.BIOGRAPHER_ENABLED !== 'true') throw new Error('BIOGRAPHER_DISABLED');
}

export const whispererRequest = z.object({
  authorId: z.string().uuid(),
  projectId: z.string().uuid(),
  locale: biographerLocale,
  turns: z
    .array(historyTurn.pick({ role: true, text: true }))
    .max(300)
    .refine(
      (turns) => turns.reduce((sum, turn) => sum + turn.text.length, 0) <= 400000,
      'Interview context exceeds supported budget',
    ),
  photos: z.array(z.object({ caption: z.string().max(4000) })).max(20),
  requestQuestion: z.boolean(),
  context: z
    .object({
      brief: z.string().max(40000).optional(),
      characterNames: z.array(z.string().max(200)).max(50).optional(),
      imageCount: z.number().int().nonnegative().max(20).optional(),
      hasAudio: z.boolean().optional(),
    })
    .optional(),
});

export const whispererCondenseRequest = whispererRequest
  .pick({
    authorId: true,
    projectId: true,
    locale: true,
  })
  .extend({
    entries: z
      .array(z.string().trim().min(1).max(40000))
      .min(1)
      .max(1000)
      .refine(
        (entries) => entries.reduce((sum, entry) => sum + entry.length, 0) <= 60000,
        'Story seed context exceeds supported budget',
      ),
    maxLength: z.number().int().min(1000).max(40000),
  });
