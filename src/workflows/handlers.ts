// -----------------------------------------------------------------------------
// Workflow Step Handlers - Individual step implementations
// -----------------------------------------------------------------------------

import { AIGateway } from '@/ai/gateway.js';
import { StoryContextService } from '@/services/story-context.js';
import { logger } from '@/config/logger.js';

// Workflow step parameter types
export interface StoryOutlineParams {
  storyId: string;
  workflowId: string;
  prompt: string;
}

export interface StoryOutlineResult {
  outline: string;
  chapters: string[];
}

export interface ChapterWritingParams {
  storyId: string;
  workflowId: string;
  outline: string;
  chapterIndex: number;
}

export interface ChapterWritingResult {
  chapterContent: string;
  wordCount: number;
}

export interface ImageGenerationParams {
  storyId: string;
  workflowId: string;
  description: string;
  style?: string;
}

export interface ImageGenerationResult {
  imageUrl: string;
  description: string;
}

export interface FinalProductionParams {
  storyId: string;
  workflowId: string;
  chapters: ChapterWritingResult[];
  images: ImageGenerationResult[];
}

export interface FinalProductionResult {
  htmlUrl: string;
  pdfUrl: string;
  status: string;
}

export interface AudioRecordingParams {
  storyId: string;
  workflowId: string;
  content: string;
}

export interface AudioRecordingResult {
  audioUrl: string;
  duration: number;
  status: string;
}

export interface WorkflowStepHandler<TParams = unknown, TResult = unknown> {
  execute(params: TParams): Promise<TResult>;
}

export class StoryOutlineHandler implements WorkflowStepHandler<StoryOutlineParams, StoryOutlineResult> {
  private storyContextService = new StoryContextService();

  async execute(params: StoryOutlineParams): Promise<StoryOutlineResult> {
    try {
      // Create AI Gateway from environment
      const aiGateway = AIGateway.fromEnvironment();
      
      // Initialize story session with context
      const session = await this.storyContextService.initializeStorySession(
        params.storyId,
        params.workflowId,
        aiGateway
      );

      // Generate outline with context
      const outline = await this.storyContextService.generateOutline(session, params.prompt);

      // Extract chapter titles from outline (simple implementation)
      const chapters = this.extractChapterTitles(outline);

      // Clean up session (optional - you might want to keep it for chapter generation)
      // await this.storyContextService.cleanupSession(session);

      logger.info('Story outline generation completed', {
        storyId: params.storyId,
        workflowId: params.workflowId,
        chaptersCount: chapters.length
      });

      return {
        outline,
        chapters
      };
    } catch (error) {
      logger.error('Story outline generation failed', {
        error: error instanceof Error ? error.message : String(error),
        storyId: params.storyId,
        workflowId: params.workflowId
      });
      throw error;
    }
  }  private extractChapterTitles(outline: string): string[] {
    // Simple regex to extract chapter titles from outline
    // This is a basic implementation - you might want to improve this
    const chapterMatches = outline.match(/Chapter \d+[:−]?\s*([^\n\r]+)/gi);
    
    if (chapterMatches) {
      return chapterMatches.map(match => {
        // Extract the title part after "Chapter X:"
        const titleMatch = match.match(/Chapter \d+[:−]?\s*(.+)/i);
        return titleMatch?.[1]?.trim() || match.trim();
      });
    }

    // Fallback: return generic chapter names
    return ['Chapter 1', 'Chapter 2', 'Chapter 3'];
  }
}

export class ChapterWritingHandler implements WorkflowStepHandler<ChapterWritingParams, ChapterWritingResult> {
  private storyContextService = new StoryContextService();

  async execute(params: ChapterWritingParams): Promise<ChapterWritingResult> {
    try {
      // Create AI Gateway from environment
      const aiGateway = AIGateway.fromEnvironment();
      
      // Create context ID from story and workflow ID
      const contextId = `${params.storyId}-${params.workflowId}`;
        // Try to get existing session or create new one
      let session;
      try {
        // Check if we have an existing context for this story
        const existingContext = await this.storyContextService.getContextManager().getContext(contextId);        if (existingContext) {
          // Reuse existing session
          const storyContext = await this.storyContextService.getStoryService().getStoryContext(params.storyId);
          if (storyContext) {
            session = {
              contextId,
              storyId: params.storyId,
              storyContext,
              currentStep: `chapter-${params.chapterIndex}`,
              aiGateway
            };
          }
        }      } catch {
        logger.debug('No existing context found, creating new session', { contextId });
      }

      // If no existing session, create new one
      if (!session) {
        session = await this.storyContextService.initializeStorySession(
          params.storyId,
          params.workflowId,
          aiGateway
        );
      }

      // Generate chapter title from index (you might want to get this from the outline)
      const chapterTitle = `Chapter ${params.chapterIndex}`;

      // Generate chapter with context
      const chapterContent = await this.storyContextService.generateChapter(
        session,
        params.chapterIndex,
        chapterTitle,
        params.outline
      );

      // Calculate word count (simple implementation)
      const wordCount = chapterContent.split(/\s+/).length;

      logger.info('Chapter generation completed', {
        storyId: params.storyId,
        workflowId: params.workflowId,
        chapterIndex: params.chapterIndex,
        wordCount
      });

      return {
        chapterContent,
        wordCount
      };
    } catch (error) {
      logger.error('Chapter generation failed', {
        error: error instanceof Error ? error.message : String(error),
        storyId: params.storyId,
        workflowId: params.workflowId,
        chapterIndex: params.chapterIndex
      });
      throw error;
    }
  }
}

export class ImageGenerationHandler implements WorkflowStepHandler<ImageGenerationParams, ImageGenerationResult> {
  async execute(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    // TODO: Implement image generation using Vertex AI Imagen
    
    // Placeholder return
    return {
      imageUrl: `https://placeholder.com/generated-image.jpg`,
      description: `Image for ${params.description}`
    };
  }
}

export class FinalProductionHandler implements WorkflowStepHandler<FinalProductionParams, FinalProductionResult> {
  async execute(params: FinalProductionParams): Promise<FinalProductionResult> {
    // TODO: Implement final production (HTML + PDF) using Puppeteer
    
    // Placeholder return
    return {
      htmlUrl: `https://storage.googleapis.com/story-output/${params.storyId}/story_v001.html`,
      pdfUrl: `https://storage.googleapis.com/story-output/${params.storyId}/story.pdf`,
      status: 'completed'
    };
  }
}

export class AudioRecordingHandler implements WorkflowStepHandler<AudioRecordingParams, AudioRecordingResult> {
  async execute(params: AudioRecordingParams): Promise<AudioRecordingResult> {
    // TODO: Implement audio recording using Google Cloud Text-to-Speech
    
    // Placeholder return
    return {
      audioUrl: `https://storage.googleapis.com/story-audio/${params.storyId}/story.mp3`,
      duration: 300, // seconds
      status: 'completed'
    };
  }
}
