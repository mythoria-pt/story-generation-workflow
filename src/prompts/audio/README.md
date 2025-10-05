# Audio TTS System Prompts

This directory contains language-specific system prompts for the Text-to-Speech (TTS) functionality in the Mythoria story generation workflow.

## File Structure

Each language has its own JSON file with the following structure:

```json
{
  "systemPrompt": "Instruction for the TTS system in the target language",
  "language": "Language code (e.g., en-US, pt-PT)",
  "languageName": "Human-readable language name",
  "targetAgeOptions": ["List of age group options in the target language"],
  "instructions": ["Best practices for TTS in this language"]
}
```

## Template Variables

The `systemPrompt` can contain template variables that will be replaced at runtime:

- `{{story-target-age}}`: Replaced with the appropriate age group from `targetAgeOptions`

## Available Languages

- **pt-PT.json**: Portuguese (Portugal) - Professional Portuguese storyteller
- **en-GB.json**: English (British) - Professional British storyteller
- **en-US.json**: English (American) - Professional American storyteller
- **fr-FR.json**: French (France) - Professional French storyteller
- **es-ES.json**: Spanish (Spain) - Professional Spanish storyteller
- **de-DE.json**: German (Germany) - Professional German storyteller
- **it-IT.json**: Italian (Italy) - Professional Italian storyteller

## TTS Best Practices Applied

These prompts follow TTS best practices for storytelling:

1. **Emotional Expression**: Emphasizes passionate and emotional delivery
2. **Target Age Appropriateness**: Adjusts tone and style for the target audience
3. **Entertainment Value**: Focuses on being fun and engaging
4. **Cultural Authenticity**: Uses appropriate regional language variants
5. **Clear Pronunciation**: Emphasizes clear articulation

## Adding New Languages

To add support for a new language:

1. Create a new JSON file named with the appropriate language code (e.g., `ja-JP.json`)
2. Follow the structure shown above
3. Translate the system prompt while maintaining the storytelling intent
4. Include appropriate target age options for that culture
5. Add language-specific TTS instructions

## Usage

The TTS service automatically loads the appropriate prompt based on the story's language setting. If a language-specific prompt is not found, it falls back to English (en-US).
