/**
 * Story Context Service
 * Manages story generation context across multiple AI requests
 */

import { AIGateway } from '@/ai/gateway.js';
import { contextManager } from '@/ai/context-manager.js';
import { StoryService, StoryContext } from './story.js';
import { logger } from '@/config/logger.js';

export interface StoryGenerationSession {
  contextId: string;
  storyId: string;
  storyContext: StoryContext;
  currentStep: string;
  aiGateway: AIGateway;
}

export class StoryContextService {
  private storyService = new StoryService();
    /**
   * Get context manager instance
   */
  getContextManager() {
    return contextManager;
  }
  
  /**
   * Get story service instance
   */
  getStoryService() {
    return this.storyService;
  }
  
  /**
   * Initialize a story generation session with context
   */
  async initializeStorySession(
    storyId: string,
    runId: string,
    aiGateway: AIGateway
  ): Promise<StoryGenerationSession> {
    try {
      // Get story context from database
      const storyContext = await this.storyService.getStoryContext(storyId);
      if (!storyContext) {
        throw new Error(`Story context not found for story ${storyId}`);
      }

      // Create context ID from story and run
      const contextId = `${storyId}-${runId}`;

      // Create system prompt that includes story context
      const systemPrompt = this.createSystemPrompt(storyContext);

      // Initialize context manager
      await contextManager.initializeContext(contextId, storyId, systemPrompt);

      // Initialize AI provider context
      const textService = aiGateway.getTextService();
      if (textService.initializeContext) {
        await textService.initializeContext(contextId, systemPrompt);
      }

      const session: StoryGenerationSession = {
        contextId,
        storyId,
        storyContext,
        currentStep: 'initialized',
        aiGateway
      };

      logger.info('Story generation session initialized', {
        contextId,
        storyId,
        runId,
        storyTitle: storyContext.story.title,
        charactersCount: storyContext.characters.length
      });

      return session;
    } catch (error) {
      logger.error('Failed to initialize story session', {
        error: error instanceof Error ? error.message : String(error),
        storyId,
        runId
      });
      throw error;
    }
  }

  /**
   * Generate story outline with context
   */
  async generateOutline(
    session: StoryGenerationSession,
    additionalPrompt?: string
  ): Promise<string> {
    try {
      const prompt = this.createOutlinePrompt(session.storyContext, additionalPrompt);
      
      const textService = session.aiGateway.getTextService();
      const outline = await textService.complete(prompt, {
        contextId: session.contextId,
        temperature: 0.8
      });

      // Update session step
      session.currentStep = 'outline-generated';

      logger.info('Story outline generated', {
        contextId: session.contextId,
        storyId: session.storyId,
        outlineLength: outline.length
      });

      return outline;
    } catch (error) {
      logger.error('Failed to generate story outline', {
        error: error instanceof Error ? error.message : String(error),
        contextId: session.contextId
      });
      throw error;
    }
  }

  /**
   * Generate chapter with context
   */
  async generateChapter(
    session: StoryGenerationSession,
    chapterNumber: number,
    chapterTitle: string,
    outline?: string
  ): Promise<string> {
    try {
      const prompt = this.createChapterPrompt(
        session.storyContext,
        chapterNumber,
        chapterTitle,
        outline
      );

      const textService = session.aiGateway.getTextService();
      const chapter = await textService.complete(prompt, {
        contextId: session.contextId,
        temperature: 0.7
      });

      // Update session step
      session.currentStep = `chapter-${chapterNumber}-generated`;

      logger.info('Story chapter generated', {
        contextId: session.contextId,
        storyId: session.storyId,
        chapterNumber,
        chapterLength: chapter.length
      });

      return chapter;
    } catch (error) {
      logger.error('Failed to generate story chapter', {
        error: error instanceof Error ? error.message : String(error),
        contextId: session.contextId,
        chapterNumber
      });
      throw error;
    }
  }

  /**
   * Clean up story session
   */
  async cleanupSession(session: StoryGenerationSession): Promise<void> {
    try {
      // Clear context from AI provider
      const textService = session.aiGateway.getTextService();
      if (textService.clearContext) {
        await textService.clearContext(session.contextId);
      }

      // Clear context from context manager
      await contextManager.clearContext(session.contextId);

      logger.info('Story session cleaned up', {
        contextId: session.contextId,
        storyId: session.storyId
      });
    } catch (error) {
      logger.error('Failed to cleanup story session', {
        error: error instanceof Error ? error.message : String(error),
        contextId: session.contextId
      });
      throw error;
    }
  }

  /**
   * Create system prompt that includes story context
   */
  private createSystemPrompt(storyContext: StoryContext): string {
    const { story, characters } = storyContext;
    
    let systemPrompt = `You are a creative storyteller helping to write a personalized story. Here are the story details:

**Story Information:**
- Title: ${story.title}
- Target Audience: ${story.targetAudience || 'General'}
- Novel Style: ${story.novelStyle || 'Adventure'}
- Setting: ${story.place || 'Not specified'}`;

    if (story.plotDescription) {
      systemPrompt += `\n- Plot Description: ${story.plotDescription}`;
    }

    if (story.synopsis) {
      systemPrompt += `\n- Synopsis: ${story.synopsis}`;
    }

    if (story.additionalRequests) {
      systemPrompt += `\n- Additional Requirements: ${story.additionalRequests}`;
    }

    if (story.imageGenerationInstructions) {
      systemPrompt += `\n- Image Generation Instructions: ${story.imageGenerationInstructions}`;
    }

    systemPrompt += `\n\n**Characters:**`;
    
    characters.forEach((char, index) => {
      systemPrompt += `\n${index + 1}. **${char.name}**`;
      if (char.role) systemPrompt += ` (${char.role})`;
      if (char.type) systemPrompt += ` - Type: ${char.type}`;
      if (char.age) systemPrompt += ` - Age: ${char.age}`;
      if (char.traits && char.traits.length > 0) systemPrompt += ` - Traits: ${char.traits.join(', ')}`;
      if (char.characteristics) systemPrompt += ` - Characteristics: ${char.characteristics}`;
      if (char.physicalDescription) systemPrompt += ` - Description: ${char.physicalDescription}`;
    });

    systemPrompt += `\n\n**Instructions:**
- Keep the story consistent with the provided character details and story settings
- Maintain continuity across all story elements
- Write in an engaging, age-appropriate style for the target audience
- Incorporate the characters' traits and characteristics naturally into the narrative
- Remember previous story elements to maintain consistency`;

    return systemPrompt;
  }
  /**
   * Create outline generation prompt
   */
  private createOutlinePrompt(_storyContext: StoryContext, additionalPrompt?: string): string {
    let prompt = `Please create a detailed story outline for this personalized story. The outline should:

1. Include a compelling beginning that introduces the characters and setting
2. Develop the main conflict or adventure
3. Include 3-5 major plot points or chapters
4. Show character growth and use of their unique abilities
5. Provide a satisfying resolution

**Character Appearance Guidelines:**
When describing characters in the outline, include detailed physical descriptions that will help with visual generation:
- Detailed descriptions of hair color, style, and length
- Eye color and distinctive facial features
- Height, build, and general appearance
- Clothing style and colors that reflect their personality
- Any distinctive accessories, jewelry, or unique characteristics
- Age-appropriate appearance details for the target audience

**Visual Scene Descriptions:**
For each major plot point or chapter, include:
- Detailed descriptions of settings and environments
- Lighting conditions (bright daylight, sunset, moonlight, etc.)
- Weather and atmospheric details
- Key visual elements that would make compelling illustrations
- Character positioning and interactions in scenes
- Emotional expressions and body language

The outline should be engaging for the target audience and incorporate all the character details provided, with enhanced visual descriptions suitable for AI image generation.`;

    if (additionalPrompt) {
      prompt += `\n\nAdditional requirements: ${additionalPrompt}`;
    }

    prompt += `\n\nPlease provide the outline in a clear, structured format with rich visual descriptions.`;

    return prompt;
  }

  /**
   * Create chapter generation prompt
   */  private createChapterPrompt(
    _storyContext: StoryContext,
    chapterNumber: number,
    chapterTitle: string,
    outline?: string
  ): string {
    let prompt = `Please write Chapter ${chapterNumber}: "${chapterTitle}" of the story.`;

    if (outline) {
      prompt += `\n\nBased on the story outline:\n${outline}`;
    }

    prompt += `\n\nChapter Requirements:
- Write approximately 800-1200 words
- Include vivid descriptions and engaging dialogue
- Show character development and interactions
- Maintain consistency with previous chapters and the overall story
- Include action and emotional moments appropriate for the target audience
- End with a natural transition to the next chapter

Please write the complete chapter content.`;

    return prompt;
  }
}
