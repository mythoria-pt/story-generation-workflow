import { PromptService } from '@/services/prompt.js';

export const SUPPORTED_TRANSLATION_LOCALES = ['en-US', 'pt-PT', 'es-ES', 'fr-FR', 'de-DE'] as const;
export type SupportedTranslationLocale = (typeof SUPPORTED_TRANSLATION_LOCALES)[number];

export type TranslationContentType = 'title' | 'text' | 'html' | 'markdown' | 'mdx' | 'slug';

export interface BuildTranslatePromptOptions {
  contentType: TranslationContentType;
  originalText: string;
  storyTitle?: string;
  sourceLocale?: string;
  extraContext?: string;
}

export async function buildTranslatePrompt(
  targetLocale: string,
  opts: BuildTranslatePromptOptions,
): Promise<string> {
  const { contentType, originalText, storyTitle, sourceLocale, extraContext } = opts;

  const promptTemplate = await PromptService.loadPrompt(targetLocale, 'translate');

  const variables = {
    isHtml: contentType === 'html' ? 'true' : '',
    isTitle: contentType === 'title' ? 'true' : '',
    isText: contentType === 'text' ? 'true' : '',
    isMarkdown: contentType === 'markdown' || contentType === 'mdx' ? 'true' : '',
    isSlug: contentType === 'slug' ? 'true' : '',
    originalText,
    storyTitle: storyTitle ?? '',
    targetLocale,
    sourceLocale: sourceLocale ?? '',
    formatDescriptor: contentType.toUpperCase(),
    extraContext: extraContext ?? '',
  } as const;

  return PromptService.buildPrompt(promptTemplate, variables as unknown as Record<string, unknown>);
}

export function cleanAITextOutput(output: string): string {
  let text = output?.trim() ?? '';

  if (text.startsWith('```')) {
    const match = text.match(/^```[a-zA-Z-]*\n([\s\S]*?)\n```$/);
    if (match && match[1]) {
      text = match[1].trim();
    } else {
      text = text.replace(/^```[\s\S]*?```$/g, '').trim();
    }
  }

  return text;
}

export function normalizeSlug(input: string, maxLength = 160): string {
  const ascii = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const collapsed = ascii.replace(/[^a-z0-9]+/g, '-');
  const trimmed = collapsed.replace(/^-+|-+$/g, '');
  return trimmed.slice(0, maxLength);
}
