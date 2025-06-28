/**
 * Runs Service
 * Handles database operations for story generation runs and steps
 */

import { eq, and } from 'drizzle-orm';
import { getWorkflowsDatabase } from '@/db/workflows-db.js';
import { storyGenerationRuns, storyGenerationSteps } from '@/db/workflows-db.js';
import { logger } from '@/config/logger.js';

export interface RunUpdate {
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | undefined;
  currentStep?: string | undefined;
  errorMessage?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface StepResult {
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
}

export class RunsService {
  private db = getWorkflowsDatabase();

  /**
   * Update a story generation run
   */  async updateRun(runId: string, updates: RunUpdate) {
    try {
      const updateData: Partial<typeof storyGenerationRuns.$inferInsert> = {
        updatedAt: new Date().toISOString()
      };

      if (updates.status) {
        updateData.status = updates.status;
        
        if (updates.status === 'running' && !updateData.startedAt) {
          updateData.startedAt = new Date().toISOString();
        }
        
        if (['completed', 'failed', 'cancelled'].includes(updates.status)) {
          updateData.endedAt = new Date().toISOString();
        }
      }

      if (updates.currentStep) {
        updateData.currentStep = updates.currentStep;
      }

      if (updates.errorMessage) {
        updateData.errorMessage = updates.errorMessage;
      }

      if (updates.metadata) {
        updateData.metadata = updates.metadata;
      }

      const [updatedRun] = await this.db
        .update(storyGenerationRuns)
        .set(updateData)
        .where(eq(storyGenerationRuns.runId, runId))
        .returning();

      if (!updatedRun) {
        throw new Error(`Run not found: ${runId}`);
      }

      logger.debug('Run updated successfully', {
        runId,
        status: updatedRun.status,
        currentStep: updatedRun.currentStep
      });

      return updatedRun;
    } catch (error) {
      logger.error('Failed to update run', {
        error: error instanceof Error ? error.message : String(error),
        runId,
        updates
      });
      throw error;
    }
  }

  /**
   * Get a story generation run by ID
   */
  async getRun(runId: string) {
    try {
      const [run] = await this.db
        .select()
        .from(storyGenerationRuns)
        .where(eq(storyGenerationRuns.runId, runId));

      return run || null;
    } catch (error) {
      logger.error('Failed to get run', {
        error: error instanceof Error ? error.message : String(error),
        runId
      });
      throw error;
    }
  }

  /**
   * Get all steps for a run
   */
  async getRunSteps(runId: string) {
    try {
      const steps = await this.db
        .select()
        .from(storyGenerationSteps)
        .where(eq(storyGenerationSteps.runId, runId));

      return steps;
    } catch (error) {
      logger.error('Failed to get run steps', {
        error: error instanceof Error ? error.message : String(error),
        runId
      });
      throw error;
    }
  }

  /**
   * Store the result of a workflow step
   */  async storeStepResult(runId: string, stepName: string, stepResult: StepResult) {
    try {
      const stepData = {
        runId,
        stepName,
        status: stepResult.status,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        startedAt: null as string | null,
        endedAt: null as string | null,        detailJson: null as unknown
      };

      if (stepResult.status === 'running') {
        stepData.startedAt = new Date().toISOString();
      }

      if (['completed', 'failed'].includes(stepResult.status)) {
        stepData.endedAt = new Date().toISOString();
      }

      if (stepResult.result) {
        stepData.detailJson = stepResult.result;
      }

      // Upsert step record
      const existingStep = await this.db
        .select()
        .from(storyGenerationSteps)
        .where(
          and(
            eq(storyGenerationSteps.runId, runId),
            eq(storyGenerationSteps.stepName, stepName)
          )
        );

      if (existingStep.length > 0) {
        // Update existing step
        await this.db
          .update(storyGenerationSteps)
          .set(stepData)
          .where(
            and(
              eq(storyGenerationSteps.runId, runId),
              eq(storyGenerationSteps.stepName, stepName)
            )
          );
      } else {
        // Insert new step
        stepData.createdAt = new Date().toISOString();
        await this.db
          .insert(storyGenerationSteps)
          .values(stepData);
      }

      logger.debug('Step result stored successfully', {
        runId,
        stepName,
        status: stepResult.status
      });

    } catch (error) {
      logger.error('Failed to store step result', {
        error: error instanceof Error ? error.message : String(error),
        runId,
        stepName,
        stepResult
      });
      throw error;
    }
  }

  /**
   * Get a specific step result
   */
  async getStepResult(runId: string, stepName: string) {
    try {
      const [step] = await this.db
        .select()
        .from(storyGenerationSteps)
        .where(
          and(
            eq(storyGenerationSteps.runId, runId),
            eq(storyGenerationSteps.stepName, stepName)
          )
        );

      return step || null;
    } catch (error) {
      logger.error('Failed to get step result', {
        error: error instanceof Error ? error.message : String(error),
        runId,
        stepName
      });
      throw error;
    }
  }
}
