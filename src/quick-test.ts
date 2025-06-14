/**
 * Quick Test for OpenAI Responses API
 * Simple verification that the new endpoint integration works
 */

import { OpenAITextService } from './ai/providers/openai/text.js';

async function quickTest() {
  const apiKey = process.env.OPENAI_API_KEY;
  
  if (!apiKey) {
    console.log('⚠️ OPENAI_API_KEY not set - skipping test');
    return;
  }

  console.log('🧪 Quick OpenAI Responses API Test\n');

  try {
    // Test Responses API
    const responsesService = new OpenAITextService({
      apiKey,
      model: 'gpt-4o',
      useResponsesAPI: true
    });

    console.log('1️⃣ Testing Responses API...');
    const response1 = await responsesService.complete(
      'Say hello in exactly 5 words.',
      { maxTokens: 20 }
    );
    console.log(`✅ Responses API: "${response1}"`);

    // Test Legacy API
    const legacyService = new OpenAITextService({
      apiKey,
      model: 'gpt-4o',
      useResponsesAPI: false
    });

    console.log('\n2️⃣ Testing Chat Completions API...');
    const response2 = await legacyService.complete(
      'Say hello in exactly 5 words.',
      { maxTokens: 20 }
    );
    console.log(`✅ Chat Completions API: "${response2}"`);

    console.log('\n🎉 Both APIs working correctly!');

  } catch (error) {
    console.error('❌ Test failed:', error instanceof Error ? error.message : String(error));
  }
}

quickTest();
