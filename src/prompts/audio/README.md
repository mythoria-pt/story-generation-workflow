# Audio TTS System Prompts

This directory contains language-specific system prompts for the Text-to-Speech (TTS) functionality in the Mythoria story generation workflow.

## Accent Enforcement

The audio prompts include a critical `<accent_enforcement>` section that is sent as a **system instruction** to the TTS API (both Google Gemini and OpenAI). This ensures consistent accent and pronunciation for each locale:

- **European Portuguese (pt-PT)**: Enforces Lisbon accent, explicitly prohibits Brazilian pronunciations
- **Brazilian Portuguese (pt-BR)**: Enforces Brazilian accent and expressions
- **American English (en-US)**: Enforces American accent, prohibits British/Australian
- **British English (en-GB)**: Enforces British Received Pronunciation
- **European Spanish (es-ES)**: Enforces Castilian Spanish with theta sounds
- **French (fr-FR)**: Enforces Metropolitan/Parisian French
- **German (de-DE)**: Enforces Standard German (Hochdeutsch)
- **Italian (it-IT)**: Enforces Standard Italian
- **Dutch (nl-NL)**: Enforces Dutch from the Netherlands (not Flemish)
- **Polish (pl-PL)**: Enforces Standard Polish

## File Structure

Each language has its own JSON file with the following structure:

```json
{
  "systemPrompt": "Complete instruction for the TTS system including accent enforcement",
  "language": "Language code (e.g., en-US, pt-PT)",
  "languageName": "Human-readable language name",
  "targetAgeOptions": ["List of age group options in the target language"],
  "instructions": ["Best practices for TTS in this language"],
  "translations": {
    "audioIntro": "Mythoria credit message template with {author} placeholder",
    "chapter": "Translated word for 'Chapter'"
  }
}
```

## System Prompt Structure

The `systemPrompt` field contains structured sections:

1. **`<narrator_profile>`**: Defines the narrator persona and target audience
2. **`<accent_enforcement>`**: CRITICAL section that enforces correct accent/dialect
3. **`<performance_style>`**: Guidelines for emotional delivery and engagement
4. **`<technical_requirements>`**: Technical speech requirements (pacing, clarity, etc.)

## Template Variables

The `systemPrompt` can contain template variables that will be replaced at runtime:

- `{{story-target-age}}`: Replaced with the appropriate age group from `targetAgeOptions`

## Available Languages

- **en-US.json**: English (American) - Professional American storyteller
- **en-GB.json**: English (British) - Professional British storyteller
- **pt-PT.json**: Portuguese (Portugal) - Professional Portuguese storyteller
- **pt-BR.json**: Portuguese (Brazil) - Professional Brazilian storyteller
- **fr-FR.json**: French (France) - Professional French storyteller
- **es-ES.json**: Spanish (Spain) - Professional Spanish storyteller
- **de-DE.json**: German (Germany) - Professional German storyteller
- **it-IT.json**: Italian (Italy) - Professional Italian storyteller
- **nl-NL.json**: Dutch (Netherlands) - Professional Dutch storyteller
- **pl-PL.json**: Polish (Poland) - Professional Polish storyteller

## How It Works

1. The `AudioPromptService.getTTSSystemPrompt()` method loads the appropriate locale file
2. The system prompt (with accent enforcement) is passed to the TTS provider via `TTSOptions.systemPrompt`
3. Both Google Gemini and OpenAI TTS providers use this prompt to enforce the correct accent
4. The prompt is sent with **every chunk** when text is split for long chapters

## Adding New Languages

To add support for a new language:

1. Create a new JSON file named with the appropriate language code (e.g., `ja-JP.json`)
2. Include all required fields, especially the `<accent_enforcement>` section
3. Add a fallback entry in `DEFAULT_ACCENT_PROMPTS` in `src/services/audio-prompt.ts`
4. Test with sample text to verify accent consistency
5. Translate the system prompt while maintaining the storytelling intent
6. Include appropriate target age options for that culture
7. Add language-specific TTS instructions

## Usage

The TTS service automatically loads the appropriate prompt based on the story's language setting. If a language-specific prompt is not found, it falls back to English (en-US).
