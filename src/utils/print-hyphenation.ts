import { hyphenateHTMLSync as hyphenateDe } from 'hyphen/de';
import { hyphenateHTMLSync as hyphenateEnGb } from 'hyphen/en-gb';
import { hyphenateHTMLSync as hyphenateEnUs } from 'hyphen/en-us';
import { hyphenateHTMLSync as hyphenateEn } from 'hyphen/en';
import { hyphenateHTMLSync as hyphenateEs } from 'hyphen/es';
import { hyphenateHTMLSync as hyphenateFr } from 'hyphen/fr';
import { hyphenateHTMLSync as hyphenateIt } from 'hyphen/it';
import { hyphenateHTMLSync as hyphenateNl } from 'hyphen/nl';
import { hyphenateHTMLSync as hyphenatePt } from 'hyphen/pt';

type HyphenateHtmlSync = (
  html: string,
  options?: {
    exceptions?: string[];
    hyphenChar?: string;
    minWordLength?: number;
  },
) => string;

const LARGE_TEXT_HYPHENATION_AUDIENCES = new Set([
  'children_0-2',
  'children_3-6',
  'children_7-10',
]);

const HYPHENATORS: Record<string, HyphenateHtmlSync> = {
  'en-us': hyphenateEnUs,
  'en-gb': hyphenateEnGb,
  de: hyphenateDe,
  en: hyphenateEn,
  es: hyphenateEs,
  fr: hyphenateFr,
  it: hyphenateIt,
  nl: hyphenateNl,
  pt: hyphenatePt,
};

const SOFT_HYPHEN = '\u00AD';
// Add per-language overrides here when editorial wants a fixed discretionary break.
const LANGUAGE_EXCEPTIONS: Partial<Record<string, string[]>> = {};

export const PRINT_HYPHENATION_MIN_WORD_LENGTH = 8;

export function getPrintDocumentLanguage(storyLanguage?: string | null): string {
  const normalizedLanguage = storyLanguage?.trim();
  return normalizedLanguage || 'en-US';
}

export function shouldApplyPrintHyphenation(targetAudience?: string | null): boolean {
  return LARGE_TEXT_HYPHENATION_AUDIENCES.has(targetAudience ?? '');
}

export function hyphenatePrintChapterHtml(
  content: string,
  storyLanguage?: string | null,
  targetAudience?: string | null,
): string {
  if (!content || !shouldApplyPrintHyphenation(targetAudience)) {
    return content;
  }

  const hyphenationKey = resolveHyphenationKey(storyLanguage);
  if (!hyphenationKey) {
    return content;
  }

  const hyphenateHtml = getHyphenator(hyphenationKey);
  if (!hyphenateHtml) {
    return content;
  }

  return hyphenateHtml(content, {
    exceptions: getHyphenationExceptions(hyphenationKey),
    hyphenChar: SOFT_HYPHEN,
    minWordLength: PRINT_HYPHENATION_MIN_WORD_LENGTH,
  });
}

function resolveHyphenationKey(storyLanguage?: string | null): string | null {
  const normalizedLanguage = getPrintDocumentLanguage(storyLanguage).toLowerCase();

  if (HYPHENATORS[normalizedLanguage]) {
    return normalizedLanguage;
  }

  const [baseLanguage] = normalizedLanguage.split('-');
  if (baseLanguage && HYPHENATORS[baseLanguage]) {
    return baseLanguage;
  }

  return null;
}

function getHyphenator(hyphenationKey: string): HyphenateHtmlSync | null {
  return HYPHENATORS[hyphenationKey] ?? null;
}

function getHyphenationExceptions(hyphenationKey: string): string[] {
  return (
    LANGUAGE_EXCEPTIONS[hyphenationKey] ??
    LANGUAGE_EXCEPTIONS[hyphenationKey.split('-')[0] || ''] ??
    []
  );
}
