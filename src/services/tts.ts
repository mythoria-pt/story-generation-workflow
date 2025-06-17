/**
 * TTS (Text-to-Speech) Service
 * Handles generating audio narration for stories
 */

import { RunsService } from './runs.js';
import { StorageService } from './storage.js';
import { logger } from '@/config/logger.js';
import { countWords } from '@/shared/utils.js';

export interface TTSResult {
  audioUrl: string;
  duration: number; // in seconds
  format: string;
  metadata: {
    totalWords: number;
    generatedAt: string;
  };
}

export class TTSService {
  private runsService: RunsService;
  private storageService: StorageService;

  constructor() {
    this.runsService = new RunsService();
    this.storageService = new StorageService();
  }

  /**
   * Generate audio narration for a story
   */
  async generateNarration(runId: string): Promise<TTSResult> {
    try {
      logger.info('Starting TTS generation', { runId });

      // Get run details
      const run = await this.runsService.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      // Get outline
      const outlineStep = await this.runsService.getStepResult(runId, 'generate_outline');
      if (!outlineStep?.detailJson) {
        throw new Error('Outline not found');
      }

      // Get all chapters
      const steps = await this.runsService.getRunSteps(runId);
      const chapterSteps = steps.filter(step => step.stepName.startsWith('write_chapter_'));      // Sort chapters by number and extract content
      const chapters = chapterSteps
        .map(step => ({
          number: parseInt(step.stepName.replace('write_chapter_', '')),
          content: (step.detailJson as Record<string, unknown>)?.chapter as string || ''
        }))
        .sort((a, b) => a.number - b.number);

      // Combine all text content
      const outline = outlineStep.detailJson as Record<string, unknown> || {};
      const fullText = this.prepareTextForTTS(outline, chapters);

      // Generate audio (placeholder implementation)
      const audioBuffer = await this.synthesizeSpeech(fullText);

      // Upload audio to storage
      const audioFilename = `stories/${runId}/narration.mp3`;
      const audioUrl = await this.storageService.uploadFile(
        audioFilename,
        audioBuffer,
        'audio/mpeg'
      );

      const result: TTSResult = {
        audioUrl,
        duration: this.estimateDuration(fullText),
        format: 'mp3',
        metadata: {
          totalWords: countWords(fullText),
          generatedAt: new Date().toISOString()
        }
      };

      logger.info('TTS generation completed', {
        runId,
        audioUrl,
        duration: result.duration,
        wordCount: result.metadata.totalWords
      });

      return result;
    } catch (error) {
      logger.error('TTS generation failed', {
        error: error instanceof Error ? error.message : String(error),
        runId
      });
      throw error;
    }
  }
  private prepareTextForTTS(outline: Record<string, unknown>, chapters: Array<{ number: number; content: string }>): string {
    const title = outline.title as string || 'Untitled Story';
    const author = outline.author as string || 'Mythoria AI';
    
    let text = `${title}. By ${author}.\n\n`;
    
    const synopsis = outline.synopsis as string;
    if (synopsis) {
      text += `${synopsis}\n\n`;
    }

    // Add chapters
    for (const chapter of chapters) {
      text += `Chapter ${chapter.number}.\n\n${chapter.content}\n\n`;
    }

    return text;
  }
  private async synthesizeSpeech(text: string): Promise<Buffer> {
    // This is a placeholder implementation
    // In production, you'd integrate with Google Cloud Text-to-Speech,
    // Azure Cognitive Services Speech, or similar services
    
    logger.warn('TTS synthesis using placeholder implementation', {
      textLength: text.length
    });
    
    // For now, return a minimal audio buffer placeholder
    // In real implementation:
    // - Call Google Cloud TTS API
    // - Handle audio format conversion
    // - Manage voice selection and speech parameters
    
    const placeholderAudio = Buffer.from('placeholder-audio-data');
    
    // Simulate processing delay
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return placeholderAudio;
  }

  private estimateDuration(text: string): number {
    // Rough estimation: average speaking rate is ~150 words per minute
    const wordCount = countWords(text);
    const wordsPerMinute = 150;
    return Math.ceil((wordCount / wordsPerMinute) * 60); // return seconds
  }

}
