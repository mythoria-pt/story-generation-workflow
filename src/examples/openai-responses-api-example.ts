/**
 * OpenAI Responses API Example
 * Demonstrates the new Responses API vs legacy Chat Completions API
 */

import { OpenAITextService } from '@/ai/providers/openai/text.js';
import { contextManager } from '@/ai/context-manager.js';

export class OpenAIResponsesAPIExample {

  /**
   * Compare Responses API vs Chat Completions API
   */
  async compareAPIEndpoints(apiKey: string): Promise<void> {
    console.log('🔄 Comparing OpenAI Responses API vs Chat Completions API\n');

    // Test with Responses API
    console.log('1️⃣ Testing with Responses API...');
    const responsesService = new OpenAITextService({
      apiKey,
      model: 'gpt-4o',
      useResponsesAPI: true
    });

    await this.testContextPreservation(responsesService, 'responses-api-test', 'Responses API');

    // Test with Chat Completions API
    console.log('\n2️⃣ Testing with Chat Completions API...');
    const chatService = new OpenAITextService({
      apiKey,
      model: 'gpt-4o',
      useResponsesAPI: false
    });

    await this.testContextPreservation(chatService, 'chat-completions-test', 'Chat Completions API');
  }

  /**
   * Test context preservation with either API
   */
  private async testContextPreservation(
    service: OpenAITextService,
    contextId: string,
    apiName: string
  ): Promise<void> {
    try {
      const systemPrompt = 'You are a creative storyteller writing about space adventures. Remember the characters and plot details throughout our conversation.';

      // Initialize context
      await contextManager.initializeContext(
        contextId,
        'test-story',
        systemPrompt
      );

      if (service.initializeContext) {
        await service.initializeContext(contextId, systemPrompt);
      }

      console.log(`✅ ${apiName}: Context initialized`);

      // First request - establish characters
      const response1 = await service.complete(
        'Create two main characters: a brave astronaut captain and a wise alien scientist. Give them names and brief descriptions.',
        { contextId, maxTokens: 200, temperature: 0.7 }
      );
      console.log(`📝 ${apiName}: Characters created`);
      console.log(`   Preview: ${response1.substring(0, 100)}...`);

      // Second request - continue the story (should remember the characters)
      const response2 = await service.complete(
        'Now describe the spaceship they travel in together. Make sure to use their names from before.',
        { contextId, maxTokens: 200, temperature: 0.7 }
      );
      console.log(`🚀 ${apiName}: Spaceship described`);
      console.log(`   Preview: ${response2.substring(0, 100)}...`);

      // Third request - build on the established context
      const response3 = await service.complete(
        'What dangerous mission do they embark on? Reference their personalities and the spaceship you just described.',
        { contextId, maxTokens: 200, temperature: 0.7 }
      );
      console.log(`⚡ ${apiName}: Mission described`);
      console.log(`   Preview: ${response3.substring(0, 100)}...`);

      // Show context information
      const context = await contextManager.getContext(contextId);
      if (context) {
        console.log(`📊 ${apiName}: Context stats:`);
        console.log(`   - Total conversation entries: ${context.conversationHistory.length}`);
        console.log(`   - Provider data: ${JSON.stringify(context.providerSpecificData.openai)}`);
      }

      // Cleanup
      if (service.clearContext) {
        await service.clearContext(contextId);
      }
      await contextManager.clearContext(contextId);
      console.log(`🧹 ${apiName}: Context cleaned up`);

    } catch (error) {
      console.error(`❌ ${apiName} test failed:`, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Demonstrate Responses API specific features
   */
  async demonstrateResponsesAPIFeatures(apiKey: string): Promise<void> {
    console.log('\n🚀 Demonstrating Responses API Specific Features\n');

    const service = new OpenAITextService({
      apiKey,
      model: 'gpt-4o',
      useResponsesAPI: true
    });

    const contextId = 'responses-features-test';

    try {
      // Initialize context
      await contextManager.initializeContext(
        contextId,
        'feature-test',
        'You are an expert assistant helping with technical documentation.'
      );

      if (service.initializeContext) {
        await service.initializeContext(contextId, 'You are an expert assistant helping with technical documentation.');
      }

      console.log('✅ Context initialized for Responses API features test');

      // Test 1: Basic conversation continuity
      console.log('\n📝 Test 1: Conversation Continuity');
      const step1 = await service.complete(
        'Explain what APIs are in simple terms.',
        { contextId, maxTokens: 150 }
      );
      console.log('Response 1:', step1.substring(0, 100) + '...');

      const step2 = await service.complete(
        'Now give me 3 specific examples of APIs that relate to your previous explanation.',
        { contextId, maxTokens: 150 }
      );
      console.log('Response 2:', step2.substring(0, 100) + '...');

      // Test 2: Context with previous response ID
      console.log('\n🔗 Test 2: Previous Response ID Usage');
      const context = await contextManager.getContext(contextId);
      const previousResponseId = context?.providerSpecificData.openai?.responseId;
      console.log(`Previous Response ID: ${previousResponseId || 'Not available'}`);

      const step3 = await service.complete(
        'Based on everything we discussed, write a summary.',
        { contextId, maxTokens: 200 }
      );
      console.log('Response 3 (with context):', step3.substring(0, 100) + '...');

      // Show final context state
      const finalContext = await contextManager.getContext(contextId);
      if (finalContext) {
        console.log('\n📊 Final Context State:');
        console.log(`- Conversation entries: ${finalContext.conversationHistory.length}`);
        console.log(`- Final Response ID: ${finalContext.providerSpecificData.openai?.responseId}`);
        console.log(`- Conversation ID: ${finalContext.providerSpecificData.openai?.conversationId}`);
      }

      // Cleanup
      await service.clearContext?.(contextId);
      await contextManager.clearContext(contextId);
      console.log('\n🧹 Features test cleaned up');

    } catch (error) {
      console.error('❌ Responses API features test failed:', error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Test error handling and fallback scenarios
   */
  async testErrorHandling(apiKey: string): Promise<void> {
    console.log('\n🛡️ Testing Error Handling and Fallback Scenarios\n');

    // Test with invalid model for Responses API
    const invalidService = new OpenAITextService({
      apiKey,
      model: 'invalid-model-name',
      useResponsesAPI: true
    });

    try {
      const response = await invalidService.complete(
        'This should fail with invalid model',
        { maxTokens: 50 }
      );
      console.log('❌ Expected error but got response:', response);
    } catch (error) {
      console.log('✅ Correctly handled invalid model error');
      console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test fallback to Chat Completions if Responses API fails
    console.log('\n🔄 Testing fallback mechanism...');
    const fallbackService = new OpenAITextService({
      apiKey,
      model: 'gpt-4o',
      useResponsesAPI: false // Use legacy API as fallback
    });

    try {
      const response = await fallbackService.complete(
        'This should work with Chat Completions API',
        { maxTokens: 50 }
      );
      console.log('✅ Fallback to Chat Completions successful');
      console.log(`   Response: ${response.substring(0, 80)}...`);
    } catch (error) {
      console.log('❌ Fallback also failed:', error instanceof Error ? error.message : String(error));
    }
  }
}

// Export for standalone execution
export const responsesAPIExample = new OpenAIResponsesAPIExample();

// Run example if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('❌ OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  console.log('🧪 OpenAI Responses API Example');
  console.log('===============================\n');

  responsesAPIExample.compareAPIEndpoints(apiKey)
    .then(() => responsesAPIExample.demonstrateResponsesAPIFeatures(apiKey))
    .then(() => responsesAPIExample.testErrorHandling(apiKey))
    .then(() => {
      console.log('\n🎉 All OpenAI Responses API tests completed!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Example failed:', error);
      process.exit(1);
    });
}
