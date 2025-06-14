/**
 * Simple Context Test
 * Basic test to verify context preservation works
 */

import { contextManager } from './ai/context-manager.js';

async function simpleTest() {
  console.log('Starting simple context test...');
  
  try {
    const contextId = 'simple-test';
    const storyId = 'simple-story';
    const systemPrompt = 'You are a storyteller.';
    
    // Test 1: Initialize
    await contextManager.initializeContext(contextId, storyId, systemPrompt);
    console.log('✅ Context initialized');
    
    // Test 2: Add entries
    await contextManager.addConversationEntry(contextId, 'user', 'Hello', 'test');
    await contextManager.addConversationEntry(contextId, 'assistant', 'Hi there!', 'test');
    console.log('✅ Entries added');
    
    // Test 3: Retrieve
    const context = await contextManager.getContext(contextId);
    console.log(`✅ Context retrieved with ${context?.conversationHistory.length} entries`);
    
    // Test 4: Stats
    const stats = contextManager.getStats();
    console.log(`✅ Stats: ${stats.totalContexts} contexts`);
    
    // Test 5: Cleanup
    await contextManager.clearContext(contextId);
    console.log('✅ Context cleared');
    
    console.log('🎉 All tests passed!');
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

simpleTest();
