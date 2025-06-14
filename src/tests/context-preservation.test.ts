/**
 * Context Preservation Tests
 * Tests for AI context management system
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { contextManager } from '@/ai/context-manager';

describe('AI Context Manager', () => {
  const testContextId = 'test-context-123';
  const testStoryId = 'test-story-456';

  beforeEach(async () => {
    // Clean up any existing test context
    await contextManager.clearContext(testContextId);
  });

  afterEach(async () => {
    // Clean up after each test
    await contextManager.clearContext(testContextId);
  });

  it('should initialize context with system prompt', async () => {
    const systemPrompt = 'You are a storyteller creating adventures.';
    
    await contextManager.initializeContext(testContextId, testStoryId, systemPrompt);
    
    const context = await contextManager.getContext(testContextId);
    expect(context).toBeTruthy();
    expect(context?.contextId).toBe(testContextId);
    expect(context?.storyId).toBe(testStoryId);
    expect(context?.systemPrompt).toBe(systemPrompt);
    expect(context?.conversationHistory).toHaveLength(1);
    expect(context?.conversationHistory[0].role).toBe('system');
    expect(context?.conversationHistory[0].content).toBe(systemPrompt);
  });

  it('should add conversation entries', async () => {
    const systemPrompt = 'You are a storyteller.';
    await contextManager.initializeContext(testContextId, testStoryId, systemPrompt);
    
    await contextManager.addConversationEntry(
      testContextId,
      'user',
      'Tell me a story about dragons',
      'outline'
    );

    await contextManager.addConversationEntry(
      testContextId,
      'assistant',
      'Once upon a time, there was a mighty dragon...',
      'outline'
    );

    const context = await contextManager.getContext(testContextId);
    expect(context?.conversationHistory).toHaveLength(3); // system + user + assistant
    expect(context?.conversationHistory[1].role).toBe('user');
    expect(context?.conversationHistory[1].content).toBe('Tell me a story about dragons');
    expect(context?.conversationHistory[2].role).toBe('assistant');
    expect(context?.conversationHistory[2].content).toBe('Once upon a time, there was a mighty dragon...');
  });

  it('should update provider-specific data', async () => {
    const systemPrompt = 'You are a storyteller.';
    await contextManager.initializeContext(testContextId, testStoryId, systemPrompt);
    
    await contextManager.updateProviderData(testContextId, {
      vertex: {
        cachedContentId: 'cached-123',
        cachedContentName: 'story-context'
      },
      openai: {
        responseId: 'response-456',
        conversationId: 'conv-789'
      }
    });

    const context = await contextManager.getContext(testContextId);
    expect(context?.providerSpecificData.vertex?.cachedContentId).toBe('cached-123');
    expect(context?.providerSpecificData.openai?.responseId).toBe('response-456');
  });

  it('should get conversation messages', async () => {
    const systemPrompt = 'You are a storyteller.';
    await contextManager.initializeContext(testContextId, testStoryId, systemPrompt);
    
    await contextManager.addConversationEntry(testContextId, 'user', 'Hello', 'test');
    await contextManager.addConversationEntry(testContextId, 'assistant', 'Hi there!', 'test');

    const messages = await contextManager.getConversationMessages(testContextId);
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[2].role).toBe('assistant');
  });

  it('should clear context', async () => {
    const systemPrompt = 'You are a storyteller.';
    await contextManager.initializeContext(testContextId, testStoryId, systemPrompt);
    
    let context = await contextManager.getContext(testContextId);
    expect(context).toBeTruthy();

    await contextManager.clearContext(testContextId);
    
    context = await contextManager.getContext(testContextId);
    expect(context).toBeNull();
  });

  it('should get context statistics', async () => {
    const systemPrompt = 'You are a storyteller.';
    await contextManager.initializeContext(testContextId, testStoryId, systemPrompt);
    await contextManager.addConversationEntry(testContextId, 'user', 'Test message', 'test');

    const stats = contextManager.getStats();
    expect(stats.totalContexts).toBeGreaterThan(0);
    
    const testContext = stats.contexts.find(c => c.contextId === testContextId);
    expect(testContext).toBeTruthy();
    expect(testContext?.storyId).toBe(testStoryId);
    expect(testContext?.entryCount).toBe(2); // system + user
  });

  it('should handle non-existent context gracefully', async () => {
    const context = await contextManager.getContext('non-existent');
    expect(context).toBeNull();

    const messages = await contextManager.getConversationMessages('non-existent');
    expect(messages).toEqual([]);
  });

  it('should throw error when adding conversation entry to non-existent context', async () => {
    await expect(
      contextManager.addConversationEntry('non-existent', 'user', 'test', 'test')
    ).rejects.toThrow('Context non-existent not found');
  });

  it('should throw error when updating provider data for non-existent context', async () => {
    await expect(
      contextManager.updateProviderData('non-existent', { vertex: { cachedContentId: 'test' } })
    ).rejects.toThrow('Context non-existent not found');
  });
});
