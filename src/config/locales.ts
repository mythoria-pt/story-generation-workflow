export const SUPPORTED_LOCALES = ['en-US', 'pt-PT', 'es-ES', 'fr-FR', 'de-DE'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en-US';

const LOCALE_ALIAS_MAP: Record<string, SupportedLocale> = {
  en: 'en-US',
  english: 'en-US',
  'en-us': 'en-US',
  pt: 'pt-PT',
  portuguese: 'pt-PT',
  'pt-pt': 'pt-PT',
  'pt-br': 'pt-PT',
  es: 'es-ES',
  spanish: 'es-ES',
  'es-es': 'es-ES',
  fr: 'fr-FR',
  french: 'fr-FR',
  'fr-fr': 'fr-FR',
  de: 'de-DE',
  german: 'de-DE',
  'de-de': 'de-DE',
};

const SUPPORTED_LOCALE_LOOKUP: Record<string, SupportedLocale> = SUPPORTED_LOCALES.reduce(
  (acc, locale) => {
    acc[locale.toLowerCase()] = locale;
    return acc;
  },
  {} as Record<string, SupportedLocale>,
);

export function normalizeLocale(locale: string | null | undefined): SupportedLocale {
  if (!locale) {
    return DEFAULT_LOCALE;
  }

  const normalizedKey = locale.toLowerCase();
  if (LOCALE_ALIAS_MAP[normalizedKey]) {
    return LOCALE_ALIAS_MAP[normalizedKey];
  }

  if (SUPPORTED_LOCALE_LOOKUP[normalizedKey]) {
    return SUPPORTED_LOCALE_LOOKUP[normalizedKey];
  }

  return DEFAULT_LOCALE;
}

export function isSupportedLocale(locale: string | null | undefined): locale is SupportedLocale {
  if (!locale) {
    return false;
  }

  const normalizedKey = locale.toLowerCase();
  return Boolean(LOCALE_ALIAS_MAP[normalizedKey] || SUPPORTED_LOCALE_LOOKUP[normalizedKey]);
}
