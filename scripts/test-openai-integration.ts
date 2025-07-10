/**
 * Test OpenAI Responses API Integration
 * This script demonstrates the new OpenAI configuration with Responses API
 */

import { OpenAITextService } from '../src/ai/providers/openai/text.js';
import { OpenAIImageService } from '../src/ai/providers/openai/image.js';
import { PromptService } from '../src/services/prompt.js';
import { getEnvironment } from '../src/config/environment.js';

async function testOpenAIIntegration() {
  try {
    const env = getEnvironment();
      if (!env.OPENAI_API_KEY) {
      console.log('❌ OPENAI_API_KEY not configured. Please set it in your environment.');
      return;
    }

    console.log('🤖 Testing OpenAI Responses API Integration...');    // Initialize OpenAI services
    const textService = new OpenAITextService({
      apiKey: env.OPENAI_API_KEY,
      model: 'gpt-4.1',
      useResponsesAPI: true
    });

    const imageService = new OpenAIImageService({
      apiKey: env.OPENAI_API_KEY,
      model: 'gpt-4.1'
    });

    // Test text generation
    console.log('\n📝 Testing text generation...');
    const textResponse = await textService.complete(
      'Write a short story about a magical forest.',
      { maxTokens: 200, temperature: 0.7 }
    );
    console.log('✅ Text generated:', textResponse.substring(0, 100) + '...');

    // Test image styles loading
    console.log('\n🎨 Testing image styles...');
    const availableStyles = await PromptService.getAvailableImageStyles();
    console.log('✅ Available image styles:', availableStyles);

    // Test specific image style
    const cartoonStyle = await PromptService.getImageStylePrompt('cartoon');
    console.log('✅ Cartoon style prompt:', cartoonStyle.systemPrompt.substring(0, 100) + '...');

    // Test image generation with style
    console.log('\n🖼️  Testing image generation...');
    const imagePrompt = `${cartoonStyle.style}, a magical forest with colorful trees and friendly animals`;
    
    console.log('Image generation prompt:', imagePrompt);
    console.log('Quality setting:', env.OPENAI_IMAGE_QUALITY);
    
    // Note: Running image generation test to debug the issue
    console.log('🖼️  Running image generation with debugging...');
    const imageBuffer = await imageService.generate(imagePrompt, {
      width: 1024,
      height: 1024,
      bookTitle: 'Test Magical Forest Story'
    });
    console.log('✅ Image generated, size:', imageBuffer.length, 'bytes');

    console.log('\n✅ All tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testOpenAIIntegration().catch(console.error);
