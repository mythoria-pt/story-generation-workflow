// -----------------------------------------------------------------------------
// Workflow Step Handlers - Individual step implementations
// -----------------------------------------------------------------------------

// AI Gateway accessed via singleton getter
import { getAIGateway } from '@/ai/gateway-singleton.js';
import { StoryContextService } from '@/services/story-context.js';
import { StoryService } from '@/services/story.js';
// Storage service accessed via singleton getter
import { getStorageService } from '@/services/storage-singleton.js';
import { PrintService } from '@/services/print.js';
import { logger } from '@/config/logger.js';
import { PromptService } from '@/services/prompt.js';
import { tmpdir } from 'os';
import { join } from 'path';

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

export class StoryOutlineHandler
  implements WorkflowStepHandler<StoryOutlineParams, StoryOutlineResult>
{
  private storyContextService = new StoryContextService();

  async execute(params: StoryOutlineParams): Promise<StoryOutlineResult> {
    try {
      // Create AI Gateway from environment
      const aiGateway = getAIGateway();

      // Initialize story session with context
      const session = await this.storyContextService.initializeStorySession(
        params.storyId,
        params.workflowId,
        aiGateway,
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
        chaptersCount: chapters.length,
      });

      return {
        outline,
        chapters,
      };
    } catch (error) {
      logger.error('Story outline generation failed', {
        error: error instanceof Error ? error.message : String(error),
        storyId: params.storyId,
        workflowId: params.workflowId,
      });
      throw error;
    }
  }
  private extractChapterTitles(outline: string): string[] {
    // Simple regex to extract chapter titles from outline
    // This is a basic implementation - you might want to improve this
    const chapterMatches = outline.match(/Chapter \d+[:−]?\s*([^\n\r]+)/gi);

    if (chapterMatches) {
      return chapterMatches.map((match) => {
        // Extract the title part after "Chapter X:"
        const titleMatch = match.match(/Chapter \d+[:−]?\s*(.+)/i);
        return titleMatch?.[1]?.trim() || match.trim();
      });
    }

    // Fallback: return generic chapter names
    return ['Chapter 1', 'Chapter 2', 'Chapter 3'];
  }
}

export class ChapterWritingHandler
  implements WorkflowStepHandler<ChapterWritingParams, ChapterWritingResult>
{
  private storyContextService = new StoryContextService();

  async execute(params: ChapterWritingParams): Promise<ChapterWritingResult> {
    try {
      // Create AI Gateway from environment
      const aiGateway = getAIGateway();

      // Create context ID from story and workflow ID
      const contextId = `${params.storyId}-${params.workflowId}`;
      // Try to get existing session or create new one
      let session;
      try {
        // Check if we have an existing context for this story
        const existingContext = await this.storyContextService
          .getContextManager()
          .getContext(contextId);
        if (existingContext) {
          // Reuse existing session
          const storyContext = await this.storyContextService
            .getStoryService()
            .getStoryContext(params.storyId);
          if (storyContext) {
            session = {
              contextId,
              storyId: params.storyId,
              storyContext,
              currentStep: `chapter-${params.chapterIndex}`,
              aiGateway,
            };
          }
        }
      } catch {
        logger.debug('No existing context found, creating new session', { contextId });
      }

      // If no existing session, create new one
      if (!session) {
        session = await this.storyContextService.initializeStorySession(
          params.storyId,
          params.workflowId,
          aiGateway,
        );
      }

      // Generate chapter title from index (you might want to get this from the outline)
      const chapterTitle = `Chapter ${params.chapterIndex}`;

      // Generate chapter with context
      const chapterContent = await this.storyContextService.generateChapter(
        session,
        params.chapterIndex,
        chapterTitle,
        params.outline,
      );

      // Calculate word count (simple implementation)
      const wordCount = chapterContent.split(/\s+/).length;

      logger.info('Chapter generation completed', {
        storyId: params.storyId,
        workflowId: params.workflowId,
        chapterIndex: params.chapterIndex,
        wordCount,
      });

      return {
        chapterContent,
        wordCount,
      };
    } catch (error) {
      logger.error('Chapter generation failed', {
        error: error instanceof Error ? error.message : String(error),
        storyId: params.storyId,
        workflowId: params.workflowId,
        chapterIndex: params.chapterIndex,
      });
      throw error;
    }
  }
}

export class ImageGenerationHandler
  implements WorkflowStepHandler<ImageGenerationParams, ImageGenerationResult>
{
  private storyService = new StoryService();

  async execute(params: ImageGenerationParams): Promise<ImageGenerationResult> {
    try {
      logger.info('Starting image generation', {
        storyId: params.storyId,
        workflowId: params.workflowId,
        imageType: params.style,
      });

      // Load story context to get custom instructions
      const storyContext = await this.storyService.getStoryContext(params.storyId);
      if (!storyContext) {
        throw new Error(`Story context not found for story ${params.storyId}`);
      }

      // Get custom image instructions from the story
      const customInstructions = storyContext.story.imageGenerationInstructions;

      // Create AI Gateway from environment
      const aiGateway = getAIGateway();

      // Determine image type and load appropriate prompt template
      let imageType: 'front_cover' | 'back_cover' | 'chapter';
      if (params.style === 'cover' || params.style === 'front_cover') {
        imageType = 'front_cover';
      } else if (params.style === 'backcover' || params.style === 'back_cover') {
        imageType = 'back_cover';
      } else {
        imageType = 'chapter';
      }

      // Load the image prompt template via PromptService
      const promptTemplate = await PromptService.loadImagePrompt(imageType);
      const finalPrompt = PromptService.buildPrompt(promptTemplate, {
        bookTitle: storyContext.story.title,
        promptText: params.description,
        customInstructions: customInstructions || '',
      });

      // Generate image using AI
      const imageService = aiGateway.getImageService();
      const imageBuffer = await imageService.generate(finalPrompt, {
        width: 1024,
        height: 1024,
        imageType: imageType,
      });

      // Upload to storage
      const storageService = getStorageService();
      const filename = this.generateImageFilename(params.storyId, imageType);
      const imageUrl = await storageService.uploadFile(filename, imageBuffer, 'image/jpeg');

      logger.info('Image generation completed', {
        storyId: params.storyId,
        workflowId: params.workflowId,
        imageType,
        imageUrl,
        hasCustomInstructions: !!customInstructions,
      });

      return {
        imageUrl,
        description: params.description,
      };
    } catch (error) {
      logger.error('Image generation failed', {
        error: error instanceof Error ? error.message : String(error),
        storyId: params.storyId,
        workflowId: params.workflowId,
      });
      throw error;
    }
  }

  // Removed custom prompt loading/building logic in favor of centralized PromptService

  private generateImageFilename(storyId: string, imageType: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (imageType === 'front_cover') {
      return `${storyId}/images/frontcover_${timestamp}.jpg`;
    } else if (imageType === 'back_cover') {
      return `${storyId}/images/backcover_${timestamp}.jpg`;
    } else {
      return `${storyId}/images/chapter_${timestamp}.jpg`;
    }
  }
}

export class FinalProductionHandler
  implements WorkflowStepHandler<FinalProductionParams, FinalProductionResult>
{
  async execute(params: FinalProductionParams): Promise<FinalProductionResult> {
    // TODO: Implement final production (HTML + PDF) using Puppeteer

    // Placeholder return
    return {
      htmlUrl: `https://storage.googleapis.com/story-output/${params.storyId}/story_v001.html`,
      pdfUrl: `https://storage.googleapis.com/story-output/${params.storyId}/story.pdf`,
      status: 'completed',
    };
  }
}

export class AudioRecordingHandler
  implements WorkflowStepHandler<AudioRecordingParams, AudioRecordingResult>
{
  async execute(params: AudioRecordingParams): Promise<AudioRecordingResult> {
    // TODO: Implement audio recording using Google Cloud Text-to-Speech

    // Placeholder return
    return {
      audioUrl: `https://storage.googleapis.com/story-audio/${params.storyId}/story.mp3`,
      duration: 300, // seconds
      status: 'completed',
    };
  }
}

// -----------------------------------------------------------------------------
// Print Generation Handlers
// -----------------------------------------------------------------------------

export interface PrintGenerationParams {
  storyId: string;
  workflowId: string;
  generateCMYK?: boolean;
}

export interface PrintGenerationResult {
  interiorPdfUrl: string;
  coverPdfUrl: string;
  interiorCmykPdfUrl?: string | null;
  coverCmykPdfUrl?: string | null;
  status: string;
}

export class PrintGenerationHandler
  implements WorkflowStepHandler<PrintGenerationParams, PrintGenerationResult>
{
  private printService = new PrintService();
  private storyService = new StoryService();
  private storageService = getStorageService();

  async execute(params: PrintGenerationParams): Promise<PrintGenerationResult> {
    try {
      logger.info(`Starting print generation for story ${params.storyId}`, {
        generateCMYK: params.generateCMYK || false,
      });

      // Fetch story data
      const storyData = await this.storyService.getStoryForPrint(params.storyId);

      if (!storyData) {
        throw new Error(`Story not found: ${params.storyId}`);
      }

      logger.debug('Story data fetched for print generation', {
        storyId: params.storyId,
        title: storyData.title,
        chapterCount: storyData.chapters?.length || 0,
      });

      // Generate temporary file paths
      const interiorPath = join(tmpdir(), `interior-${params.storyId}.pdf`);
      const coverPath = join(tmpdir(), `cover-${params.storyId}.pdf`);

      // Use the new generatePrintSet method that handles both RGB and CMYK
      const printResult = await this.printService.generatePrintSet(
        storyData,
        interiorPath,
        coverPath,
        { generateCMYK: params.generateCMYK !== false },
      );

      // Upload RGB PDFs to storage
      const fs = await import('fs');
      const interiorBuffer = fs.readFileSync(printResult.interiorPdfPath);
      const coverBuffer = fs.readFileSync(printResult.coverPdfPath);

      // Upload post-processed interior PDF
      const interiorPdfUrl = await this.storageService.uploadFile(
        `${params.storyId}/print/interior.pdf`,
        interiorBuffer,
        'application/pdf',
      );

      const coverPdfUrl = await this.storageService.uploadFile(
        `${params.storyId}/print/cover.pdf`,
        coverBuffer,
        'application/pdf',
      );

      // Prepare result
      const result: PrintGenerationResult = {
        interiorPdfUrl,
        coverPdfUrl,
        interiorCmykPdfUrl: null,
        coverCmykPdfUrl: null,
        status: 'completed',
      };

      // Upload CMYK PDFs if they were generated
      if (printResult.interiorCmykPdfPath && printResult.coverCmykPdfPath) {
        const interiorCmykBuffer = fs.readFileSync(printResult.interiorCmykPdfPath);
        const coverCmykBuffer = fs.readFileSync(printResult.coverCmykPdfPath);
        const interiorCmykUrl = await this.storageService.uploadFile(
          `${params.storyId}/print/interior_cmyk.pdf`,
          interiorCmykBuffer,
          'application/pdf',
        );
        const coverCmykUrl = await this.storageService.uploadFile(
          `${params.storyId}/print/cover_cmyk.pdf`,
          coverCmykBuffer,
          'application/pdf',
        );
        result.interiorCmykPdfUrl = interiorCmykUrl;
        result.coverCmykPdfUrl = coverCmykUrl;
      }

      // Generate HTML for debugging purposes
      const pageCount = this.estimatePageCount(storyData);
      const dimensions = this.printService.calculateDimensions(pageCount);
      const interiorHtml = this.printService.generateInteriorHTML(storyData, dimensions);
      const coverHtml = this.printService.generateCoverHTML(storyData, dimensions);

      // Upload HTML files for debugging and style adjustments
      const interiorHtmlBuffer = Buffer.from(interiorHtml, 'utf-8');
      const coverHtmlBuffer = Buffer.from(coverHtml, 'utf-8');

      await this.storageService.uploadFile(
        `${params.storyId}/print/interior.html`,
        interiorHtmlBuffer,
        'text/html',
      );

      await this.storageService.uploadFile(
        `${params.storyId}/print/cover.html`,
        coverHtmlBuffer,
        'text/html',
      );

      // Update story with preferred PDF URLs (prefer CMYK when available)
      await this.storyService.updateStoryPrintUrls(params.storyId, {
        interiorPdfUri: result.interiorCmykPdfUrl ?? result.interiorPdfUrl,
        coverPdfUri: result.coverCmykPdfUrl ?? result.coverPdfUrl,
      });

      logger.info(`Print generation completed for story ${params.storyId}`, {
        interiorPdfUrl: result.interiorPdfUrl,
        coverPdfUrl: result.coverPdfUrl,
        interiorCmykPdfUrl: result.interiorCmykPdfUrl,
        coverCmykPdfUrl: result.coverCmykPdfUrl,
        htmlFilesGenerated: true,
      });

      return result;
    } catch (error) {
      logger.error(`Print generation failed for story ${params.storyId}:`, error);
      throw error;
    }
  }

  private estimatePageCount(storyData: any): number {
    // Estimate pages: 5 front matter pages + ~2 pages per chapter + 1 blank final page
    const frontMatterPages = 5;
    const pagesPerChapter = 2;
    const finalBlankPage = 1;

    return frontMatterPages + storyData.chapters.length * pagesPerChapter + finalBlankPage;
  }
}
