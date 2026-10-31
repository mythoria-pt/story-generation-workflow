import { z } from 'zod';
import { targetAudienceEnum, novelStyleEnum, graphicalStyleEnum } from '@/db/schema/enums.js';

export const storyPreferencesSchema = z
  .object({
    targetAudience: z.enum(targetAudienceEnum.enumValues).optional(),
    novelStyle: z.enum(novelStyleEnum.enumValues).optional(),
    graphicalStyle: z.enum(graphicalStyleEnum.enumValues).optional(),
    tone: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type StoryPreferences = z.infer<typeof storyPreferencesSchema>;

export const storyGuideRequestSchema = z
  .object({
    authorId: z.string().uuid(),
    guideSessionId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    locale: z.enum(['en-US', 'pt-PT', 'es-ES', 'fr-FR', 'de-DE']),
    template: z
      .object({
        id: z.string().min(1).max(80),
        version: z.number().int().positive(),
        premise: z.string().min(1).max(4000),
        mode: z.enum(['fiction', 'memory']),
        // Authored fallback questions are handled by the WebApp, never by the model.
        fallbackQuestions: z.array(z.unknown()).max(9).optional(),
      })
      .strict(),
    answers: z
      .array(
        z
          .object({
            questionId: z.string().min(1).max(80),
            question: z.string().min(1).max(300),
            answer: z.string().min(1).max(1500),
          })
          .strict(),
      )
      .max(9),
    previousQuestions: z.array(z.string().min(1).max(300)).max(9).optional(),
    preferences: storyPreferencesSchema.optional(),
    contribution: z.string().max(8000).optional(),
    premise: z.string().trim().max(4000).optional(),
    photoAnswers: z.boolean().optional(),
  })
  .strict();

export const guideQuestionSchema = z
  .object({
    id: z.string().min(1).max(80),
    text: z.string().min(1).max(240),
    choices: z
      .array(
        z
          .object({
            id: z.string().min(1).max(40),
            label: z.string().min(1).max(100),
            value: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(3)
      .max(4),
    suggestedChoiceId: z.string().nullable(),
    photoTarget: z.literal('protagonist').nullable().optional(),
  })
  .strict()
  .superRefine((q, ctx) => {
    if (
      new Set(q.choices.map((c) => c.id)).size !== q.choices.length ||
      (q.suggestedChoiceId !== null && !q.choices.some((c) => c.id === q.suggestedChoiceId))
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid choice identifiers' });
    }
  });
export const guideOutputSchema = z.object({ question: guideQuestionSchema.nullable() }).strict();
export type StoryGuideRequest = z.infer<typeof storyGuideRequestSchema>;

export const MEMORY_INSTRUCTION =
  'Preserve only user-supplied real facts. Do not invent factual events, dates, identities, relationships or quotations. Leave unknown facts unspecified. Creative wording must not introduce factual claims.';

export function mergeStoryPreferences(
  extracted: Record<string, unknown>,
  preferences?: StoryPreferences,
  factuality?: 'memory',
): Record<string, unknown> {
  const result = { ...extracted };
  if (preferences) {
    const { tone, ...fields } = storyPreferencesSchema.parse(preferences);
    Object.assign(result, fields);
    if (tone)
      result.additionalRequests = [result.additionalRequests, `Tone: ${tone}`]
        .filter(Boolean)
        .join('\n');
  }
  if (factuality === 'memory') {
    result.additionalRequests = [result.additionalRequests, MEMORY_INSTRUCTION]
      .filter(Boolean)
      .join('\n');
  }
  return result;
}
