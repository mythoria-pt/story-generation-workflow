/**
 * Context Preservation Validation Script
 * Simple script to validate that context preservation is working
 */

import { contextManager } from './ai/context-manager.js';
import { AIGateway } from './ai/gateway.js';
import { logger } from './config/logger.js';

async function validateContextPreservation() {
  console.log('🧪 Testing Context Preservation System...\n');

  try {
    // Test 1: Context Manager Basic Operations
    console.log('1️⃣ Testing Context Manager...');
    
    const testContextId = 'test-context-validation';
    const testStoryId = 'test-story-validation';
    const systemPrompt = 'You are a creative storyteller helping to write adventure stories.';

    // Initialize context
    await contextManager.initializeContext(testContextId, testStoryId, systemPrompt);
    console.log('✅ Context initialized successfully');

    // Add conversation entries
    await contextManager.addConversationEntry(testContextId, 'user', 'Create a story about dragons', 'outline');
    await contextManager.addConversationEntry(testContextId, 'assistant', 'Here is a dragon story outline...', 'outline');
    console.log('✅ Conversation entries added successfully');

    // Get context
    const context = await contextManager.getContext(testContextId);
    if (context && context.conversationHistory.length === 3) {
      console.log('✅ Context retrieved with correct history length');
    } else {
      throw new Error('Context history not correct');
    }

    // Update provider data
    await contextManager.updateProviderData(testContextId, {
      vertex: { cachedContentId: 'test-cached-123' },
      openai: { responseId: 'test-response-456' }
    });
    console.log('✅ Provider data updated successfully');

    // Get stats
    const stats = contextManager.getStats();
    console.log(`✅ Context stats: ${stats.totalContexts} active contexts`);

    // Clean up
    await contextManager.clearContext(testContextId);
    console.log('✅ Context cleaned up successfully');

    // Test 2: AI Gateway Integration
    console.log('\n2️⃣ Testing AI Gateway Integration...');
    
    try {
      const aiGateway = AIGateway.fromEnvironment();
      const textService = aiGateway.getTextService();
      
      console.log('✅ AI Gateway initialized successfully');
      
      // Check if context methods are available
      if (textService.initializeContext && textService.clearContext) {
        console.log('✅ Context methods available on text service');
      } else {
        console.log('⚠️ Context methods not available (this is expected for some providers)');
      }

    } catch (error) {
      console.log(`⚠️ AI Gateway test skipped: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 3: Context Persistence Across Multiple Operations
    console.log('\n3️⃣ Testing Context Persistence...');
    
    const persistTestContextId = 'persist-test-context';
    const persistTestStoryId = 'persist-test-story';
    
    // Initialize
    await contextManager.initializeContext(
      persistTestContextId, 
      persistTestStoryId, 
      'You are writing a fantasy adventure.'
    );
    
    // Simulate multiple story generation steps
    await contextManager.addConversationEntry(persistTestContextId, 'user', 'Generate outline', 'outline');
    await contextManager.addConversationEntry(persistTestContextId, 'assistant', 'Outline: Chapter 1, Chapter 2, Chapter 3', 'outline');
    
    await contextManager.addConversationEntry(persistTestContextId, 'user', 'Write Chapter 1', 'chapter-1');
    await contextManager.addConversationEntry(persistTestContextId, 'assistant', 'Chapter 1: The hero begins...', 'chapter-1');
    
    await contextManager.addConversationEntry(persistTestContextId, 'user', 'Write Chapter 2', 'chapter-2');
    await contextManager.addConversationEntry(persistTestContextId, 'assistant', 'Chapter 2: The adventure continues...', 'chapter-2');
    
    // Verify persistence
    const persistContext = await contextManager.getContext(persistTestContextId);
    if (persistContext && persistContext.conversationHistory.length === 7) { // system + 6 entries
      console.log('✅ Context persisted across multiple operations');
      console.log(`   - Total entries: ${persistContext.conversationHistory.length}`);
      const lastEntry = persistContext.conversationHistory[persistContext.conversationHistory.length - 1];
      console.log(`   - Last entry: ${lastEntry?.content?.substring(0, 50)}...`);
    } else {
      throw new Error('Context persistence failed');
    }
    
    // Clean up
    await contextManager.clearContext(persistTestContextId);
    console.log('✅ Persistence test cleaned up');

    console.log('\n🎉 All Context Preservation Tests Passed!');
    
    return true;

  } catch (error) {
    console.error('\n❌ Context Preservation Test Failed:');
    console.error(error instanceof Error ? error.message : String(error));
    logger.error('Context preservation validation failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

// Run validation if this script is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  validateContextPreservation()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(error => {
      console.error('Validation script error:', error);
      process.exit(1);
    });
}

export { validateContextPreservation };
