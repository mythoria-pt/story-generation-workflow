/**
 * Pure helpers for TTS transcripts.
 *
 * Inline pause tags (`<short pause>`, `<long pause>`) are deliberately not used: Gemini TTS
 * can read them aloud (translated), and a paragraph break already yields the same pause.
 * These helpers remove any stray tag so it can never reach a TTS provider.
 */

const PAUSE_TAG_PATTERN = /[ \t]*<(?:short|long|medium) pause>[ \t]*/gi;

/** True when the text contains an angle-bracket pause tag. */
export function containsPauseTag(text: string): boolean {
  return /<(?:short|long|medium) pause>/i.test(text);
}

/**
 * Remove angle-bracket pause tags. Text without tags is returned untouched; otherwise the
 * tag is replaced by a single space and surrounding horizontal whitespace is tidied while
 * line breaks (paragraph pauses) are preserved.
 */
export function stripPauseTags(text: string): string {
  if (!containsPauseTag(text)) return text;
  return text
    .replace(PAUSE_TAG_PATTERN, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
