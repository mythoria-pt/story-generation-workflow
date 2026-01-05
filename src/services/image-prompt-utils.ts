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

// Builds a more neutral fallback prompt aimed at avoiding safety blocks.
export function buildSafeFallbackPrompt(
  original: string,
  opts: { styleHint?: string } = {},
): string {
  let prompt = original || '';

  prompt = prompt.replace(/\b\d+\s*-?\s*month\s*-?\s*old\b/gi, 'young');
  prompt = prompt.replace(/\btoddler\b/gi, 'child');
  prompt = prompt.replace(/\bboy\b/gi, 'child');
  prompt = prompt.replace(/\bgirl\b/gi, 'child');

  if (!/safe|wholesome|cheerful/i.test(prompt)) {
    prompt += ' The scene is wholesome, safe, and cheerful.';
  }

  if (!/clothed|wearing|dressed|outfit|attire/i.test(prompt)) {
    prompt += ' The character is fully clothed in appropriate daily attire.';
  }

  if (!/lighting|lit/i.test(prompt)) {
    prompt += ' Warm, gentle lighting.';
  }

  return refineImagePrompt(prompt, {
    styleHint: opts.styleHint || 'wholesome family illustration, soft lighting',
  });
}

export function logPromptRefinementFailure(error: unknown): void {
  logger.warn('Prompt refinement failed (non-fatal)', {
    error: error instanceof Error ? error.message : String(error),
  });
}
