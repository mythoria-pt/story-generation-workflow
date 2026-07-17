/**
 * Scratch script to verify TTS provider switching and fallback logic
 */
import { getProviderForVoice, getDefaultVoiceForProvider } from '../src/services/voice-registry.js';

console.log('--- Voice Provider Detection ---');
const testVoices = ['Charon', 'fable', 'Aoede', 'alloy', 'unknown'];
testVoices.forEach((voice) => {
  const provider = getProviderForVoice(voice);
  console.log(`Voice: ${voice} -> Provider: ${provider || 'Not found'}`);
});

console.log('\n--- Default Voices ---');
console.log(`Default for google-genai: ${getDefaultVoiceForProvider('google-genai')}`);
console.log(`Default for openai: ${getDefaultVoiceForProvider('openai')}`);

// Simulated fallback logic
function simulateSynthesize(voice, provider) {
  console.log(`Synthesizing with voice "${voice}" on provider "${provider}"...`);

  // Simulate voice validation (similar to what the real services do)
  const isGeminiVoice = [
    'Charon',
    'Aoede',
    'Puck',
    'Kore',
    'Fenrir',
    'Orus',
    'Zephyr',
    'Sulafat',
  ].includes(voice);
  const isOpenAIVoice = [
    'alloy',
    'ash',
    'ballad',
    'coral',
    'echo',
    'fable',
    'nova',
    'onyx',
    'sage',
    'shimmer',
    'verse',
  ].includes(voice);

  if (provider === 'google-genai' && !isGeminiVoice) {
    throw new Error('404 Not Found: Voice not available');
  }
  if (provider === 'openai' && !isOpenAIVoice) {
    throw new Error('404 Not Found: Voice not available');
  }

  return 'SUCCESS';
}

async function testSynthesisFlow(requestedVoice, configuredProvider) {
  console.log(
    `\nTesting Request: voice="${requestedVoice}", defaultProvider="${configuredProvider}"`,
  );

  let effectiveProvider = configuredProvider;
  const detectedProvider = getProviderForVoice(requestedVoice);

  if (detectedProvider && detectedProvider !== configuredProvider) {
    console.log(`[Smart Switch] Switching to ${detectedProvider}`);
    effectiveProvider = detectedProvider;
  }

  try {
    const result = simulateSynthesize(requestedVoice, effectiveProvider);
    console.log(`Result: ${result}`);
  } catch (error) {
    console.log(`[Error] ${error.message}`);
    if (error.message.includes('404')) {
      const fallbackVoice = getDefaultVoiceForProvider(effectiveProvider);
      console.log(`[Fallback] Retrying with ${fallbackVoice}`);
      const fallbackResult = simulateSynthesize(fallbackVoice, effectiveProvider);
      console.log(`Fallback Result: ${fallbackResult}`);
    }
  }
}

async function runTests() {
  // Case 1: Matching provider (Google/Charon)
  await testSynthesisFlow('Charon', 'google-genai');

  // Case 2: Smart switch (OpenAI/fable requested on Google default)
  await testSynthesisFlow('fable', 'google-genai');

  // Case 3: Unknown voice -> Fallback to default of configured provider
  await testSynthesisFlow('unknown', 'google-genai');

  // Case 4: Known voice but mismatch (simulating if smart switch failed)
  // This shouldn't happen with the new logic but good to test the fallback block
  console.log('\nTesting Fallback Block directly:');
  const errorMsg = '404 Not Found';
  if (errorMsg.includes('404')) {
    console.log(
      `Fallback would trigger for provider google-genai to: ${getDefaultVoiceForProvider('google-genai')}`,
    );
  }
}

runTests();
