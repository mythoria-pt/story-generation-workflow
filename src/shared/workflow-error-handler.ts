/**
 * Workflow Error Handler
 * Centralized error handling for workflow operations with better diagnostics
 */

import { logger } from '@/config/logger.js';
import { RunsService } from '@/services/runs.js';
import { StoryService } from '@/services/story.js';

export interface WorkflowError {
  type: 'STORY_NOT_FOUND' | 'ORPHANED_RUN' | 'DATABASE_ERROR' | 'VALIDATION_ERROR' | 'UNKNOWN_ERROR';
  message: string;
  details: Record<string, unknown>;
  recoverable: boolean;
  suggestedAction?: string;
}

export class WorkflowErrorHandler {
  private runsService = new RunsService();
  private storyService = new StoryService();

  /**
   * Handle story not found errors with detailed diagnostics
   */
  async handleStoryNotFound(storyId: string, runId?: string): Promise<WorkflowError> {
    const details = {
      storyId,
      runId,
      timestamp: new Date().toISOString()
    };

    try {
      // Check if story exists in main database
      const storyExists = await this.storyService.storyExists(storyId);
      
      if (!storyExists) {
        // Story doesn't exist - this is an orphaned run
        const error: WorkflowError = {
          type: 'ORPHANED_RUN',
          message: `Story ${storyId} does not exist in the database. This appears to be an orphaned workflow run.`,
          details: {
            ...details,
            storyExists: false,
            reason: 'Story may have been deleted or never created'
          },
          recoverable: false,
          suggestedAction: 'Cancel the workflow run and clean up orphaned data'
        };

        // If we have a runId, mark the run as failed
        if (runId) {
          try {
            await this.runsService.updateRun(runId, {
              status: 'failed',
              errorMessage: 'Story not found - orphaned run detected'
            });
            logger.info('Marked orphaned run as failed', { runId, storyId });
          } catch (updateError) {
            logger.error('Failed to update orphaned run status', {
              runId,
              storyId,
              error: updateError instanceof Error ? updateError.message : String(updateError)
            });
          }
        }

        return error;
      } else {
        // Story exists but context couldn't be loaded
        return {
          type: 'VALIDATION_ERROR',
          message: `Story ${storyId} exists but context could not be loaded. Missing required data.`,
          details: {
            ...details,
            storyExists: true,
            reason: 'Story may be missing characters or other required fields'
          },
          recoverable: true,
          suggestedAction: 'Check story data integrity and ensure all required fields are present'
        };
      }
    } catch (error) {
      return {
        type: 'DATABASE_ERROR',
        message: `Database error while checking story ${storyId}`,
        details: {
          ...details,
          error: error instanceof Error ? error.message : String(error)
        },
        recoverable: true,
        suggestedAction: 'Retry operation after checking database connectivity'
      };
    }
  }

  /**
   * Handle general workflow errors
   */
  async handleWorkflowError(
    error: Error,
    context: { runId?: string; storyId?: string; step?: string }
  ): Promise<WorkflowError> {
    const details = {
      ...context,
      timestamp: new Date().toISOString(),
      errorMessage: error.message,
      errorStack: error.stack
    };

    // Categorize the error
    if (error.message.includes('Story not found') || error.message.includes('not found')) {
      if (context.storyId) {
        return this.handleStoryNotFound(context.storyId, context.runId);
      }
    }

    if (error.message.includes('ECONNREFUSED') || error.message.includes('connection')) {
      return {
        type: 'DATABASE_ERROR',
        message: 'Database connection failed',
        details,
        recoverable: true,
        suggestedAction: 'Check database connectivity and retry'
      };
    }

    // Default unknown error
    return {
      type: 'UNKNOWN_ERROR',
      message: error.message,
      details,
      recoverable: true,
      suggestedAction: 'Review error details and consider manual intervention'
    };
  }

  /**
   * Log workflow error with structured data
   */
  logWorkflowError(workflowError: WorkflowError): void {
    const logLevel = workflowError.recoverable ? 'warn' : 'error';
    
    logger[logLevel]('Workflow error occurred', {
      errorType: workflowError.type,
      message: workflowError.message,
      recoverable: workflowError.recoverable,
      suggestedAction: workflowError.suggestedAction,
      details: workflowError.details
    });
  }

  /**
   * Create standardized error response for API endpoints
   */
  createErrorResponse(workflowError: WorkflowError) {
    return {
      success: false,
      error: workflowError.message,
      errorType: workflowError.type,
      recoverable: workflowError.recoverable,
      suggestedAction: workflowError.suggestedAction,
      details: workflowError.details
    };
  }
}

export const workflowErrorHandler = new WorkflowErrorHandler();
