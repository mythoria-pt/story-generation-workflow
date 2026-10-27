# Audio TTS Prompts

This directory holds per-locale TTS configuration for the Mythoria audiobook pipeline.

## File structure

Each locale (`en-US`, `en-GB`, `pt-PT`, `pt-BR`, `es-ES`, `fr-FR`, `de-DE`, `it-IT`, `nl-NL`, `pl-PL`) has one JSON file:

```json
{
  "language": "pt-PT",
  "languageName": "Portuguese (Portugal)",
  "baseStyle": {
    "toddlers": "Soft, gentle, sing-song storyteller, slow and soothing",
    "children": "Warm, playful storyteller, unhurried, smiling through the words",
    "young adults": "Engaging, expressive storyteller with natural, lively pacing",
    "adults": "Rich, immersive narrator, measured and expressive",
    "general audience": "Warm, engaging storyteller with natural, expressive pacing"
  },
  "translations": {
    "audioIntro": "Mythoria credit template with {author} placeholder",
    "chapter": "Translated word for 'Chapter'"
  }
}
```

- `baseStyle` is one short English delivery-style line per target age (English is fine for every locale per Google guidance). Do not mention accent, age, gender or "keep the voice consistent"; the accent comes from `speechConfig.languageCode`, the voice from the voice name.
- Target ages come from `extractTargetAge()` in `src/shared/utils.ts`. Unknown or missing ages (including `all_ages`) resolve to `general audience`.
- `translations` are read by `AudioPromptService.getTranslatedChapter()` / `getTranslatedAudioIntro()`.

## How it is used

1. `AudioPromptService.getBaseStyle(locale, targetAge)` resolves the style (fallback chain: locale file, then `en-US`, then built-in defaults).
2. `TTSService` passes it per chunk as `TTSOptions.style` (via `resolveChunkStyle()`), together with `languageCode` (the story locale when it is BCP-47).
3. Gemini (`gemini-3.8-flash-tts`) sends the transcript verbatim as a part with `speechMetadata.style`. Nothing but the story text is ever placed in the spoken transcript.
4. OpenAI receives `AudioPromptService.getTTSSystemPrompt()` (accent hint from `DEFAULT_ACCENT_PROMPTS` plus the base style) through the API `instructions` parameter.
5. Pauses come from paragraph breaks: the title, dedication, Mythoria credit, chapter heading and body are joined with blank lines. Inline pause tags (`<short pause>`, `<long pause>`) are deliberately not used because the model can read them aloud; both providers strip any stray tag defensively.

## Adding a new language

1. Create `<locale>.json` with `language`, `languageName`, `baseStyle` (all five ages) and `translations`.
2. Add an accent hint to `DEFAULT_ACCENT_PROMPTS` in `src/services/audio-prompt.ts` (used by the OpenAI provider).
3. Make sure the locale is a valid BCP-47 tag so Gemini receives `languageCode`.
