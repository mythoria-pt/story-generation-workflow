import { z } from 'zod';

export const biographerLocale = z.enum(['en-US', 'pt-PT', 'es-ES', 'fr-FR', 'de-DE']);
export const historyTurn = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().max(40000),
});
export const projectContext = z.object({
  projectTitle: z.string().max(500).optional(),
  subject: z.string().max(1000).optional(),
  purpose: z.string().max(2000).optional(),
  places: z.array(z.string().max(200)).max(20).optional(),
  photoCaptions: z.array(z.string().max(2000)).max(20).optional(),
  period: z.string().max(200).optional(),
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
