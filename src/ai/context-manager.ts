/**
 * AI Context Manager - Simplified for Stateful Conversation APIs
 * Manages session identifiers and provider-specific data for story generation
 * Note: Conversation history is now handled natively by OpenAI Responses API and Google GenAI Chat instances
 */

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
  providerSpecificData: ProviderContextData;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderContextData {
  // OpenAI Response API - stores response_id for stateful conversations
  openai?: {
    responseId?: string;
  };

  // Google GenAI - stores chat instance for stateful conversations
  googleGenAI?: {
    chatInstance?: { sendMessage: (message: string) => Promise<unknown> } | undefined; // Chat instance from genAI
  };
}

/**
 * Context Manager handles storing and retrieving session data for stateful AI conversations
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
   * Update provider-specific context data (e.g., response_id, chat instances)
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
  getStats(): { totalContexts: number; contexts: Array<{ contextId: string; storyId: string; updatedAt: Date }> } {
    const contexts = Array.from(this.contexts.values()).map(context => ({
      contextId: context.contextId,
      storyId: context.storyId,
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
