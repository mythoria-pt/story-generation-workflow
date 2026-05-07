import { logger } from '@/config/logger.js';

// Normalizes and enriches image prompts for consistency across providers.
export function refineImagePrompt(
  raw: string,
  opts: { fallbackSubject?: string; styleHint?: string } = {},
): string {
  if (!raw || typeof raw !== 'string') {
    return opts.fallbackSubject || 'storybook illustration, soft lighting';
  }
  let prompt = raw
    .replace(/\s+/g, ' ') // collapse whitespace
    .replace(/^\s+|\s+$/g, '')
    .replace(/^"|"$/g, '');

  // Remove leading articles that add little value
  prompt = prompt.replace(/^(?:An?|The)\s+/i, '');

  // Ensure it describes a scene, not a command
  prompt = prompt.replace(/^Imagine\s+/, '');

  const lower = prompt.toLowerCase();
  const styleProvided =
    /(illustration|digital painting|oil painting|watercolor|pixel art|anime|storybook|cinematic|render)/.test(
      lower,
    );
  const style = styleProvided ? '' : opts.styleHint || 'storybook illustration, soft lighting';

  // Cap length to avoid provider limits
  if (prompt.length > 600) {
    const cut = prompt.slice(0, 600);
    const lastPeriod = cut.lastIndexOf('.');
    prompt = lastPeriod > 60 ? cut.slice(0, lastPeriod + 1) : cut;
  }

  prompt = prompt.replace(/[-,;:]+$/, '').trim();

  return style ? `${prompt} – ${style}` : prompt;
}

// Builds a generic, no-people fallback prompt designed to bypass safety blocks.
// Drops the original narrative entirely (which is likely what triggered the
// moderation block) and synthesizes a neutral scene from sanitized context fields.
export function buildSafeFallbackPrompt(
  _original: string,
  opts: {
    styleHint?: string;
    imageType?: 'front_cover' | 'back_cover' | 'chapter';
    chapterNumber?: number;
    bookTitle?: string;
  } = {},
): string {
  let subject: string;
  switch (opts.imageType) {
    case 'front_cover':
      subject = 'a decorative storybook front cover';
      break;
    case 'back_cover':
      subject = 'a calm decorative storybook back cover';
      break;
    case 'chapter':
    default:
      subject = opts.chapterNumber
        ? `a gentle storybook scene for chapter ${opts.chapterNumber}`
        : 'a gentle storybook scene';
      break;
  }

  const scene =
    'Whimsical landscape with no people, soft pastel colors, warm gentle lighting, wholesome and family-friendly composition.';

  return refineImagePrompt(`${subject}. ${scene}`, {
    styleHint: opts.styleHint || 'wholesome family illustration, soft lighting',
  });
}

export function logPromptRefinementFailure(error: unknown): void {
  logger.warn('Prompt refinement failed (non-fatal)', {
    error: error instanceof Error ? error.message : String(error),
  });
}
