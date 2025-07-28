/**
 * Progress Tracker Service
 * Calculates and updates story generation completion percentage based on workflow steps
 */

import { RunsService } from './runs.js';
import { StoryService } from './story.js';
import { logger } from '@/config/logger.js';
import { retry } from '@/shared/utils.js';

export interface WorkflowStep {
  stepName: string;
  estimatedTime: number; // in seconds
  isPerChapter?: boolean; // true if this step is executed per chapter
}

export interface ProgressCalculation {
  completedPercentage: number;
  totalEstimatedTime: number;
  elapsedTime: number;
  remainingTime: number;
  currentStep: string;
  completedSteps: string[];
  totalSteps: number;
}

export class ProgressTrackerService {
  private runsService: RunsService;
  private storyService: StoryService;

  // Base workflow steps with estimated times
  private readonly baseWorkflowSteps: WorkflowStep[] = [
    { stepName: 'generate_outline', estimatedTime: 15 },
    { stepName: 'write_chapters', estimatedTime: 25, isPerChapter: true },
    { stepName: 'generate_front_cover', estimatedTime: 60 },
    { stepName: 'generate_back_cover', estimatedTime: 60 },
    { stepName: 'generate_images', estimatedTime: 30, isPerChapter: true },
    { stepName: 'assemble', estimatedTime: 10 },
    { stepName: 'generate_audiobook', estimatedTime: 20 },
    { stepName: 'done', estimatedTime: 1 }
  ];

  constructor() {
    this.runsService = new RunsService();
    this.storyService = new StoryService();
    
    // Clean up expired cache entries periodically
    setInterval(() => {
      this.cleanupExpiredCache();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Clean up expired cache entries
   */
  private cleanupExpiredCache(): void {
    const now = Date.now();
    for (const [runId, cached] of this.chapterCountCache) {
      if (now - cached.timestamp > ProgressTrackerService.CACHE_TTL) {
        this.chapterCountCache.delete(runId);
      }
    }
  }

  // Cache chapter counts to avoid repeated database queries
  private chapterCountCache = new Map<string, { count: number; timestamp: number }>();
  private static readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Calculate the expected number of chapters from the outline or database
   */
  private async getChapterCount(runId: string): Promise<number> {
    try {
      // Check cache first
      const cached = this.chapterCountCache.get(runId);
      if (cached && Date.now() - cached.timestamp < ProgressTrackerService.CACHE_TTL) {
        return cached.count;
      }

      // First, try to get chapter count from the outline
      const outlineStep = await this.runsService.getStepResult(runId, 'generate_outline');
      
      if (outlineStep?.detailJson && typeof outlineStep.detailJson === 'object') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const outline = outlineStep.detailJson as any;
        
        // Try to extract chapter count from outline structure
        if (outline.chapters && Array.isArray(outline.chapters)) {
          logger.debug('Chapter count determined from outline', { 
            runId, 
            chapterCount: outline.chapters.length 
          });
          const count = outline.chapters.length;
          this.chapterCountCache.set(runId, { count, timestamp: Date.now() });
          return count;
        }
        
        // Alternative: look for numbered chapters in the outline
        if (outline.content && typeof outline.content === 'string') {
          const chapterMatches = outline.content.match(/Chapter\s+\d+/gi);
          if (chapterMatches) {
            logger.debug('Chapter count determined from outline content', { 
              runId, 
              chapterCount: chapterMatches.length 
            });
            const count = chapterMatches.length;
            this.chapterCountCache.set(runId, { count, timestamp: Date.now() });
            return count;
          }
        }
      }
      
      // If outline doesn't have chapter count, read from database
      logger.debug('Chapter count not available in outline, checking database', { runId });
      
      const run = await this.runsService.getRun(runId);
      if (run?.storyId) {
        const story = await this.storyService.getStory(run.storyId);
        if (story?.chapterCount) {
          logger.debug('Chapter count determined from database', { 
            runId, 
            storyId: run.storyId,
            chapterCount: story.chapterCount 
          });
          const count = story.chapterCount;
          this.chapterCountCache.set(runId, { count, timestamp: Date.now() });
          return count;
        }
      }
      
      // Final fallback - typical children's book has 3-5 chapters
      logger.warn('Could not determine chapter count from outline or database, using default of 4', { runId });
      const count = 4;
      this.chapterCountCache.set(runId, { count, timestamp: Date.now() });
      return count;
      
    } catch (error) {
      logger.error('Failed to get chapter count', {
        error: error instanceof Error ? error.message : String(error),
        runId
      });
      // Cache the default value to prevent repeated failures
      const count = 4;
      this.chapterCountCache.set(runId, { count, timestamp: Date.now() });
      return count;
    }
  }

  /**
   * Calculate total estimated time for the workflow
   */
  private async calculateTotalEstimatedTime(runId: string): Promise<number> {
    const chapterCount = await this.getChapterCount(runId);
    let totalTime = 0;

    for (const step of this.baseWorkflowSteps) {
      if (step.isPerChapter) {
        totalTime += step.estimatedTime * chapterCount;
      } else {
        totalTime += step.estimatedTime;
      }
    }

    return totalTime;
  }
  /**
   * Get all completed steps for a run
   */
  private async getCompletedSteps(runId: string): Promise<string[]> {
    try {
      const steps = await this.runsService.getRunSteps(runId);
      return steps
        .filter(step => step.status === 'completed')
        .map(step => step.stepName);
    } catch (error) {
      logger.error('Failed to get completed steps', {
        error: error instanceof Error ? error.message : String(error),
        runId
      });
      return [];
    }
  }  /**
   * Calculate elapsed time for completed steps
   */
  private async calculateElapsedTime(runId: string, completedSteps: string[]): Promise<number> {
    const chapterCount = await this.getChapterCount(runId);
    let elapsedTime = 0;

    for (const stepName of completedSteps) {
      // Handle individual chapter steps
      if (stepName.startsWith('write_chapter_')) {
        const writeChaptersStep = this.baseWorkflowSteps.find(ws => ws.stepName === 'write_chapters');
        if (writeChaptersStep) {
          elapsedTime += writeChaptersStep.estimatedTime; // Add time for each completed chapter
        }
      } else if (stepName.startsWith('generate_image_chapter_')) {
        // Handle individual chapter image generation steps
        const generateImagesStep = this.baseWorkflowSteps.find(ws => ws.stepName === 'generate_images');
        if (generateImagesStep) {
          elapsedTime += generateImagesStep.estimatedTime; // Add time for each completed chapter image
        }
      } else {
        // Handle other workflow steps
        const workflowStep = this.baseWorkflowSteps.find(ws => ws.stepName === stepName);
        if (workflowStep) {
          if (workflowStep.isPerChapter) {
            elapsedTime += workflowStep.estimatedTime * chapterCount;
          } else {
            elapsedTime += workflowStep.estimatedTime;
          }
        }
      }
    }

    return elapsedTime;
  }

  /**
   * Calculate completion percentage for a story generation run
   */
  async calculateProgress(runId: string): Promise<ProgressCalculation> {
    try {
      const run = await this.runsService.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      const totalEstimatedTime = await this.calculateTotalEstimatedTime(runId);
      const completedSteps = await this.getCompletedSteps(runId);
      const elapsedTime = await this.calculateElapsedTime(runId, completedSteps);
      
      const completedPercentage = Math.min(
        Math.round((elapsedTime / totalEstimatedTime) * 100),
        100
      );

      const remainingTime = Math.max(totalEstimatedTime - elapsedTime, 0);
      const chapterCount = await this.getChapterCount(runId);
      
      // Calculate total steps considering dynamic chapter count
      const totalSteps = this.baseWorkflowSteps.reduce((total, step) => {
        return total + (step.isPerChapter ? chapterCount : 1);
      }, 0);

      const result: ProgressCalculation = {
        completedPercentage,
        totalEstimatedTime,
        elapsedTime,
        remainingTime,
        currentStep: run.currentStep || 'unknown',
        completedSteps,
        totalSteps
      };

      logger.debug('Progress calculated', {
        runId,
        ...result
      });

      return result;

    } catch (error) {
      logger.error('Failed to calculate progress', {
        error: error instanceof Error ? error.message : String(error),
        runId
      });
      throw error;
    }
  }

  // Track ongoing progress updates to prevent concurrent updates for the same run
  private activeUpdates = new Set<string>();

  /**
   * Update the story's completion percentage
   */
  async updateStoryProgress(runId: string): Promise<void> {
    // Prevent concurrent updates for the same runId
    if (this.activeUpdates.has(runId)) {
      logger.debug('Progress update already in progress, skipping', { runId });
      return;
    }

    this.activeUpdates.add(runId);
    
    try {
      // Use retry logic for the entire progress update operation
      await retry(async () => {
        const run = await this.runsService.getRun(runId);
        if (!run) {
          throw new Error(`Run not found: ${runId}`);
        }

        // Skip progress updates for failed runs to avoid repetitive processing
        if (run.status === 'failed') {
          logger.debug('Skipping progress update for failed run', { runId, status: run.status });
          return;
        }

        const progress = await this.calculateProgress(runId);
        
        // If the run is completed, ensure 100% completion
        let finalPercentage = progress.completedPercentage;
        if (run.status === 'completed' && run.currentStep === 'done') {
          finalPercentage = 100;
        }
        
        // Update the story's completion percentage
        await this.storyService.updateStoryCompletionPercentage(
          run.storyId,
          finalPercentage
        );

        // If the run is completed, update story status to published
        if (run.status === 'completed' && run.currentStep === 'done') {
          await this.storyService.updateStoryStatus(run.storyId, 'published');
        }

        logger.info('Story progress updated', {
          runId,
          storyId: run.storyId,
          completedPercentage: finalPercentage,
          currentStep: progress.currentStep,
          completedSteps: progress.completedSteps.length,
          totalSteps: progress.totalSteps,
          storyStatus: run.status === 'completed' && run.currentStep === 'done' ? 'published' : 'unchanged'
        });
      }, 3, 1000); // 3 retries, starting with 1s delay

    } catch (error) {
      logger.error('Failed to update story progress', {
        error: error instanceof Error ? error.message : String(error),
        runId
      });
      throw error;
    } finally {
      this.activeUpdates.delete(runId);
    }
  }  /**
   * Get the estimated completion percentage for a specific step
   * This is useful for real-time updates during step execution
   */
  async getStepCompletionEstimate(runId: string, stepName: string, stepProgress: number = 0): Promise<number> {
    try {
      const baseProgress = await this.calculateProgress(runId);
      const chapterCount = await this.getChapterCount(runId);
      
      // Handle individual chapter steps
      let currentWorkflowStep: WorkflowStep | undefined;
      if (stepName.startsWith('write_chapter_')) {
        currentWorkflowStep = this.baseWorkflowSteps.find(ws => ws.stepName === 'write_chapters');
      } else if (stepName.startsWith('generate_image_chapter_')) {
        currentWorkflowStep = this.baseWorkflowSteps.find(ws => ws.stepName === 'generate_images');
      } else {
        currentWorkflowStep = this.baseWorkflowSteps.find(ws => ws.stepName === stepName);
      }
      
      if (!currentWorkflowStep) {
        return baseProgress.completedPercentage;
      }

      // Calculate the time value of the current step
      let currentStepTime: number;
      if (stepName.startsWith('write_chapter_') || stepName.startsWith('generate_image_chapter_')) {
        // For individual chapters or chapter images, use the time for one chapter
        currentStepTime = currentWorkflowStep.estimatedTime;
      } else {
        currentStepTime = currentWorkflowStep.isPerChapter 
          ? currentWorkflowStep.estimatedTime * chapterCount
          : currentWorkflowStep.estimatedTime;
      }

      // Add the progress within the current step
      const additionalTime = currentStepTime * (stepProgress / 100);
      const totalElapsedTime = baseProgress.elapsedTime + additionalTime;
      
      const estimatedPercentage = Math.min(
        Math.round((totalElapsedTime / baseProgress.totalEstimatedTime) * 100),
        100
      );

      return estimatedPercentage;

    } catch (error) {
      logger.error('Failed to get step completion estimate', {
        error: error instanceof Error ? error.message : String(error),
        runId,
        stepName,
        stepProgress
      });
      return 0;
    }
  }
}
