/**
 * AI Context Manager
 * Manages conversation context across multiple AI requests for story generation
 */

// import { logger } from '../config/log.js';

// Simple logging for now to avoid test issues
const log = {
  info: (msg: string, ...args: unknown[]) => console.log(`[INFO] ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[ERROR] ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => console.log(`[DEBUG] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[WARN] ${msg}`, ...args),
};

export interface ContextData {
  contextId: string;
  storyId: string;
  systemPrompt: string;
  conversationHistory: ConversationEntry[];
  providerSpecificData: ProviderContextData;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationEntry {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: Date;
  step: string; // e.g., 'outline', 'chapter-1', 'chapter-2'
}

export interface ProviderContextData {
  // Google Vertex AI Context Cache
  vertex?: {
    cachedContentName?: string;
    cachedContentId?: string;
  };
  
  // OpenAI Response API
  openai?: {
    responseId?: string;
    conversationId?: string;
  };
}

/**
 * Context Manager handles storing and retrieving context data
 * Currently uses in-memory storage but can be extended to use Redis or database
 */
export class AIContextManager {
  private contexts: Map<string, ContextData> = new Map();
  
  /**
   * Initialize context for a story generation session
   */
  async initializeContext(
    contextId: string,
    storyId: string,
    systemPrompt: string
  ): Promise<void> {
    const contextData: ContextData = {
      contextId,
      storyId,
      systemPrompt,
      conversationHistory: [{
        role: 'system',
        content: systemPrompt,
        timestamp: new Date(),
        step: 'initialization'
      }],
      providerSpecificData: {},
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    this.contexts.set(contextId, contextData);
    
    log.info('Context initialized', {
      contextId,
      storyId,
      systemPromptLength: systemPrompt.length
    });
  }
  
  /**
   * Get context data
   */
  async getContext(contextId: string): Promise<ContextData | null> {
    const context = this.contexts.get(contextId);
    if (!context) {
      log.warn('Context not found', { contextId });
      return null;
    }
    
    return context;
  }
  
  /**
   * Add conversation entry to context
   */
  async addConversationEntry(
    contextId: string,
    role: 'user' | 'assistant',
    content: string,
    step: string
  ): Promise<void> {
    const context = this.contexts.get(contextId);
    if (!context) {
      log.error('Cannot add conversation entry: context not found', { contextId });
      throw new Error(`Context ${contextId} not found`);
    }
    
    context.conversationHistory.push({
      role,
      content,
      timestamp: new Date(),
      step
    });
    
    context.updatedAt = new Date();
    
    log.debug('Conversation entry added', {
      contextId,
      role,
      step,
      contentLength: content.length,
      totalEntries: context.conversationHistory.length
    });
  }
  
  /**
   * Update provider-specific context data
   */
  async updateProviderData(
    contextId: string,
    providerData: Partial<ProviderContextData>
  ): Promise<void> {
    const context = this.contexts.get(contextId);
    if (!context) {
      log.error('Cannot update provider data: context not found', { contextId });
      throw new Error(`Context ${contextId} not found`);
    }
    
    context.providerSpecificData = {
      ...context.providerSpecificData,
      ...providerData
    };
    
    context.updatedAt = new Date();
    
    log.debug('Provider context data updated', {
      contextId,
      providerData
    });
  }
  
  /**
   * Clear context
   */
  async clearContext(contextId: string): Promise<void> {
    const deleted = this.contexts.delete(contextId);
    
    if (deleted) {
      log.info('Context cleared', { contextId });
    } else {
      log.warn('Context not found when clearing', { contextId });
    }
  }
  
  /**
   * Get conversation history as messages array for AI providers
   */
  async getConversationMessages(contextId: string): Promise<ConversationEntry[]> {
    const context = this.contexts.get(contextId);
    if (!context) {
      return [];
    }
    
    return context.conversationHistory;
  }
  
  /**
   * Clear old contexts (cleanup method)
   */
  async cleanupOldContexts(maxAgeHours: number = 24): Promise<void> {
    const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    let removedCount = 0;
    
    for (const [contextId, context] of this.contexts.entries()) {
      if (context.updatedAt < cutoffTime) {
        this.contexts.delete(contextId);
        removedCount++;
      }
    }
    
    if (removedCount > 0) {
      log.info('Old contexts cleaned up', {
        removedCount,
        maxAgeHours,
        remainingCount: this.contexts.size
      });
    }
  }
  
  /**
   * Get context statistics
   */
  getStats(): { totalContexts: number; contexts: Array<{ contextId: string; storyId: string; entryCount: number; updatedAt: Date }> } {
    const contexts = Array.from(this.contexts.values()).map(context => ({
      contextId: context.contextId,
      storyId: context.storyId,
      entryCount: context.conversationHistory.length,
      updatedAt: context.updatedAt
    }));
    
    return {
      totalContexts: this.contexts.size,
      contexts
    };
  }
}

// Singleton instance
export const contextManager = new AIContextManager();
