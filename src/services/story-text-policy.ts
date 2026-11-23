import { parse } from 'node-html-parser';
import { z } from 'zod';

export type StoryTextMode = 'whole_story' | 'chapter_by_chapter';
export interface StoryTextPolicy {
  mode: 'hybrid' | 'chapter_by_chapter';
  audiences: string[];
  threshold: number;
  wholeBudget: number;
  chapterBudget: number;
}
export function selectStoryTextMode(
  audience: string,
  count: number,
  policy: StoryTextPolicy,
): StoryTextMode {
  return policy.mode === 'chapter_by_chapter' ||
    (policy.audiences.includes(audience) && count >= policy.threshold)
    ? 'chapter_by_chapter'
    : 'whole_story';
}
/** Preserve the depth measured in the existing adult prose pipeline; explicit author/genre requirements win. */
export function narrativeLengthGuidance(audience: string): string {
  return ['young_adult_15-17', 'adult_18+'].includes(audience)
    ? 'For prose fiction, aim for approximately 1,500-2,000 words per chapter with developed scenes, dialogue and reflection. Give each chapter the same depth it would receive when written individually. Do not compress later chapters to fit a single response. Explicit author length requests and concise genres such as poetry take precedence.'
    : 'Follow the audience paragraph and scene-depth guidance. Give every chapter a complete scene, without summarizing the remaining plot.';
}

export const wholeStorySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['chapters'],
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chapterNumber', 'htmlContent'],
        properties: { chapterNumber: { type: 'integer' }, htmlContent: { type: 'string' } },
      },
    },
  },
};
const storyOutput = z
  .object({
    chapters: z.array(
      z
        .object({ chapterNumber: z.number().int().positive(), htmlContent: z.string().min(1) })
        .strict(),
    ),
  })
  .strict();
export function validateChapterHtml(html: string, audience: string): void {
  const root = parse(html);
  if (!root.textContent.trim() || !root.querySelector('p'))
    throw new Error('Chapter prose must contain nonempty paragraphs');
  const allowed = new Set(['P', 'STRONG', 'EM', 'SPAN', 'BR']);
  for (const element of root.querySelectorAll('*')) {
    if (!allowed.has(element.tagName)) throw new Error('Unsupported chapter HTML');
    for (const [key, value] of Object.entries(element.attributes)) {
      if (element.tagName !== 'SPAN' || key !== 'style' || !/^font-size:\s*1\.2em;?$/i.test(value))
        throw new Error('Unsupported chapter HTML attribute');
    }
  }
  if (
    root.childNodes.some(
      (node) =>
        (node.nodeType === 3 && node.textContent.trim()) ||
        (node.nodeType === 1 && 'tagName' in node && node.tagName !== 'P'),
    )
  )
    throw new Error('Chapter prose outside paragraphs');
  if (root.querySelectorAll('p').some((paragraph) => !paragraph.textContent.trim()))
    throw new Error('Empty chapter paragraph');
  const paragraphs = root.querySelectorAll('p').length;
  if (
    (audience === 'children_0-2' && paragraphs > 2) ||
    (audience === 'children_3-6' && paragraphs > 4)
  )
    throw new Error('Chapter exceeds audience paragraph limit');
}
export function validateWholeStory(text: string, chapterCount: number, audience: string) {
  const result = storyOutput.parse(JSON.parse(text));
  if (result.chapters.length !== chapterCount) throw new Error('Incomplete story chapter count');
  result.chapters.forEach((chapter, index) => {
    if (chapter.chapterNumber !== index + 1)
      throw new Error('Story chapters must be unique and ordered');
    validateChapterHtml(chapter.htmlContent, audience);
  });
  return result.chapters;
}
