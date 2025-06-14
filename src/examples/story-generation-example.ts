/**
 * Example: Context-Aware Story Generation
 * Demonstrates how to use the context preservation system
 */

import { AIGateway } from '@/ai/gateway.js';
import { StoryContextService, StoryGenerationSession } from '@/services/story-context.js';
import { contextManager } from '@/ai/context-manager.js';
import { logger } from '@/config/logger.js';

export class StoryGenerationExample {
  private storyContextService = new StoryContextService();

  /**
   * Example: Generate a complete story with context preservation
   */  async generateStoryWithContext(storyId: string, runId: string): Promise<void> {
    let session: StoryGenerationSession | undefined;
    
    try {
      // Initialize AI Gateway
      const aiGateway = AIGateway.fromEnvironment();
      
      // Initialize story session with context
      session = await this.storyContextService.initializeStorySession(
        storyId,
        runId,
        aiGateway
      );

      logger.info('Starting story generation with context', {
        contextId: session.contextId,
        storyTitle: session.storyContext.story.title,
        charactersCount: session.storyContext.characters.length
      });

      // Step 1: Generate story outline
      console.log('🎯 Generating story outline...');
      const outline = await this.storyContextService.generateOutline(
        session,
        'Create an exciting adventure story with clear character development'
      );
      console.log('📋 Outline generated:', outline.substring(0, 200) + '...');

      // Step 2: Generate chapters
      const chapterTitles = this.extractChapterTitles(outline);
      console.log('📚 Chapters to generate:', chapterTitles);      for (let i = 0; i < Math.min(chapterTitles.length, 3); i++) {
        const chapterNumber = i + 1;
        const chapterTitle = chapterTitles[i] || `Chapter ${chapterNumber}`;
        
        console.log(`✍️ Generating Chapter ${chapterNumber}: ${chapterTitle}...`);
        
        const chapter = await this.storyContextService.generateChapter(
          session,
          chapterNumber,
          chapterTitle,
          outline
        );
        
        console.log(`📖 Chapter ${chapterNumber} generated (${chapter.length} characters)`);
        console.log('Preview:', chapter.substring(0, 150) + '...');
      }      // Display context statistics
      const stats = contextManager.getStats();
      const sessionContext = session ? stats.contexts.find(c => c.contextId === session?.contextId) : null;
      console.log('📊 Context Statistics:', {
        totalContexts: stats.totalContexts,
        currentSessionEntries: sessionContext ? sessionContext.entryCount : 0
      });

      logger.info('Story generation completed successfully', {
        contextId: session.contextId,
        storyId
      });

    } catch (error) {
      logger.error('Story generation failed', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        runId
      });
      throw error;
    } finally {
      // Clean up session
      if (session) {
        await this.storyContextService.cleanupSession(session);
        console.log('🧹 Session cleaned up');
      }
    }
  }

  /**
   * Example: Show context preservation between requests
   */
  async demonstrateContextPreservation(storyId: string, runId: string): Promise<void> {
    const aiGateway = AIGateway.fromEnvironment();
    const textService = aiGateway.getTextService();
    const contextId = `demo-${storyId}-${runId}`;

    try {
      // Initialize context
      await contextManager.initializeContext(
        contextId,
        storyId,
        'You are helping write a fantasy adventure story about brave heroes.'
      );

      if (textService.initializeContext) {
        await textService.initializeContext(
          contextId,
          'You are helping write a fantasy adventure story about brave heroes.'
        );
      }

      console.log('🎬 Demonstrating context preservation...');

      // First request - establish characters
      console.log('\n1️⃣ First request: Establish characters');
      const response1 = await textService.complete(
        'Introduce two main characters: a brave knight and a clever wizard. Give them names and brief descriptions.',
        { contextId, maxTokens: 300 }
      );
      console.log('Response 1:', response1.substring(0, 200) + '...');

      // Second request - should remember the characters
      console.log('\n2️⃣ Second request: Continue with the same characters');
      const response2 = await textService.complete(
        'Now describe how these two characters first met. Use their names and personalities from before.',
        { contextId, maxTokens: 300 }
      );
      console.log('Response 2:', response2.substring(0, 200) + '...');

      // Third request - build on the story
      console.log('\n3️⃣ Third request: Build on the established story');
      const response3 = await textService.complete(
        'What adventure do they embark on together? Reference their meeting and characters.',
        { contextId, maxTokens: 300 }
      );
      console.log('Response 3:', response3.substring(0, 200) + '...');

      // Show conversation history
      const context = await contextManager.getContext(contextId);
      if (context) {
        console.log('\\n📜 Conversation History:');
        context.conversationHistory.forEach((entry, index) => {
          console.log(`${index + 1}. ${entry.role}: ${entry.content.substring(0, 100)}...`);
        });
      }

    } finally {
      // Clean up
      if (textService.clearContext) {
        await textService.clearContext(contextId);
      }
      await contextManager.clearContext(contextId);
      console.log('🧹 Demo context cleaned up');
    }
  }

  /**
   * Utility: Extract chapter titles from outline
   */  private extractChapterTitles(outline: string): string[] {
    const chapterMatches = outline.match(/Chapter \d+[:−]?\s*([^\n\r]+)/gi);
    
    if (chapterMatches) {
      return chapterMatches.map(match => {
        const titleMatch = match.match(/Chapter \d+[:−]?\s*(.+)/i);
        return titleMatch?.[1]?.trim() || match.trim();
      });
    }

    return ['The Beginning', 'The Adventure', 'The Resolution'];
  }
}

// Export for use in tests or standalone execution
export const storyExample = new StoryGenerationExample();
