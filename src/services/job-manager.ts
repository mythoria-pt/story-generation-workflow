/**
 * Simple In-Memory Job Manager
 * Handles async job tracking with simulated progress for AI editing operations
 */

import { randomUUID } from 'crypto';
import { logger } from '@/config/logger.js';

export type JobType = 'text_edit' | 'image_edit';
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: number; // 0-100
  result?: any;
  error?: string;
  startTime: Date;
  estimatedDuration: number; // milliseconds
  metadata?: {
    storyId: string;
    operationType: string;
    chapterCount?: number;
    chapterNumber?: number;
    imageType?: string;
  };
}

class JobManager {
  private jobs = new Map<string, Job>();
  private progressIntervals = new Map<string, NodeJS.Timeout>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Auto-cleanup completed jobs every 10 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupOldJobs();
    }, 10 * 60 * 1000);
  }

  /**
   * Create a new job and start progress simulation
   */
  createJob(
    type: JobType, 
    metadata: Job['metadata'], 
    estimatedDuration: number
  ): string {
    const jobId = randomUUID();
    
    const job: Job = {
      id: jobId,
      type,
      status: 'pending',
      progress: 0,
      startTime: new Date(),
      estimatedDuration,
      ...(metadata && { metadata })
    };

    this.jobs.set(jobId, job);
    this.startProgressSimulation(jobId);

    logger.info('Job created', {
      jobId,
      type,
      estimatedDuration,
      metadata
    });

    return jobId;
  }

  /**
   * Get job status by ID
   */
  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Update job status
   */
  updateJobStatus(jobId: string, status: JobStatus, result?: any, error?: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = status;
    if (result) job.result = result;
    if (error) job.error = error;

    // Complete progress and stop simulation when job finishes
    if (status === 'completed' || status === 'failed') {
      job.progress = status === 'completed' ? 100 : job.progress;
      this.stopProgressSimulation(jobId);
    }

    this.jobs.set(jobId, job);

    logger.info('Job status updated', {
      jobId,
      status,
      progress: job.progress,
      hasResult: !!result,
      hasError: !!error
    });
  }

  /**
   * Start simulated progress for a job
   */
  private startProgressSimulation(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    // Update progress every 2 seconds
    const updateInterval = 2000;
    const totalUpdates = job.estimatedDuration / updateInterval;
    const progressIncrement = 95 / totalUpdates; // Stop at 95% to leave room for completion

    job.status = 'processing';
    this.jobs.set(jobId, job);

    const interval = setInterval(() => {
      const currentJob = this.jobs.get(jobId);
      if (!currentJob || currentJob.status !== 'processing') {
        clearInterval(interval);
        return;
      }

      // Increment progress but don't exceed 95%
      currentJob.progress = Math.min(95, currentJob.progress + progressIncrement);
      this.jobs.set(jobId, currentJob);

      logger.debug('Job progress updated', {
        jobId,
        progress: currentJob.progress
      });
    }, updateInterval);

    this.progressIntervals.set(jobId, interval);
  }

  /**
   * Stop progress simulation for a job
   */
  private stopProgressSimulation(jobId: string): void {
    const interval = this.progressIntervals.get(jobId);
    if (interval) {
      clearInterval(interval);
      this.progressIntervals.delete(jobId);
    }
  }

  /**
   * Clean up old completed jobs (older than 10 minutes)
   */
  private cleanupOldJobs(): void {
    const cutoffTime = new Date(Date.now() - 10 * 60 * 1000);
    let cleanedCount = 0;

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.startTime < cutoffTime && (job.status === 'completed' || job.status === 'failed')) {
        this.jobs.delete(jobId);
        this.stopProgressSimulation(jobId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} old jobs`);
    }
  }

  /**
   * Cleanup on shutdown
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Stop all progress intervals
    for (const interval of this.progressIntervals.values()) {
      clearInterval(interval);
    }
    
    this.progressIntervals.clear();
    this.jobs.clear();
  }
}

/**
 * Get estimated duration based on job type and parameters
 */
export function getEstimatedDuration(type: JobType, params: {
  chapterCount?: number;
  operationType?: string;
}): number {
  switch (type) {
    case 'text_edit':
      if (params.operationType === 'story' && params.chapterCount) {
        // Full story edit: 45 seconds per chapter
        return params.chapterCount * 45 * 1000;
      }
      // Single chapter edit: 45 seconds
      return 45 * 1000;
    
    case 'image_edit':
      // Image edit: 90 seconds
      return 90 * 1000;
    
    default:
      return 60 * 1000; // Default fallback
  }
}

// Singleton instance
export const jobManager = new JobManager();

// Graceful shutdown cleanup
process.on('SIGTERM', () => jobManager.destroy());
process.on('SIGINT', () => jobManager.destroy());
