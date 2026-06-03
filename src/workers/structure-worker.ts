/**
 * Story Structure Worker
 * Processes async story-structure jobs by delegating to the shared
 * generateStoryStructure service and recording the result on the job.
 */

import { logger } from '@/config/logger.js';
import { jobManager } from '@/services/job-manager.js';
import {
  generateStoryStructure,
  type GenerateStoryStructureParams,
} from '@/services/story-structure.js';

export async function processStoryStructureJob(
  jobId: string,
  params: GenerateStoryStructureParams,
): Promise<void> {
  try {
    logger.info('Starting story structure job', {
      jobId,
      storyId: params.storyId,
      imageCount: params.imageObjectPaths?.length ?? 0,
      hasAudio: !!params.audioObjectPath,
    });

    jobManager.updateJobStatus(jobId, 'processing');

    const result = await generateStoryStructure(params);

    jobManager.updateJobStatus(jobId, 'completed', result);

    logger.info('Story structure job completed', {
      jobId,
      storyId: params.storyId,
      characterCount: Array.isArray(result.characters) ? result.characters.length : 0,
    });
  } catch (error) {
    logger.error('Story structure job failed', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    jobManager.updateJobStatus(
      jobId,
      'failed',
      undefined,
      error instanceof Error ? error.message : 'Processing failed',
    );
  }
}
