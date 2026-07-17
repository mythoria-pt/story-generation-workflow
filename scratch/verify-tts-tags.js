import { processTextForTTS } from '../src/services/tts-utils.js';
import { AudioPromptService } from '../src/services/audio-prompt.js';

// Mock environment for Gemini 3.1
process.env.TTS_MODEL = 'gemini-3.1-flash-tts-preview';

console.log('--- Testing Gemini 3.1 Tag Insertion ---');

const testText = 'Hello... this is a test! Amazing; really incredible.';
const processed = processTextForTTS(testText);
console.log('Processed for TTS:', processed);

const enhanced = AudioPromptService.enhanceTextForTTS(
  processed,
  'You are a passionate storyteller',
  ['Use proper punctuation'],
);
console.log('Enhanced for TTS:', enhanced);

if (
  enhanced.includes('[long pause]') &&
  enhanced.includes('[excited]') &&
  enhanced.includes('[short pause]')
) {
  console.log('✅ ALL TAGS PRESENT');
} else {
  console.log('❌ SOME TAGS MISSING');
  if (!enhanced.includes('[long pause]')) console.log('- Missing [long pause]');
  if (!enhanced.includes('[excited]')) console.log('- Missing [excited]');
  if (!enhanced.includes('[short pause]')) console.log('- Missing [short pause]');
}
