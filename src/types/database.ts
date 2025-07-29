/**
 * Type definitions for database operations and API responses
 */

export interface StoryGenerationRun {
  runId: string;
  storyId: string;
  gcpWorkflowExecution?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  currentStep?: string;
  errorMessage?: string;
  startedAt?: string;
  endedAt?: string;  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StoryGenerationStep {
  runId: string;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  detailJson?: Record<string, unknown>;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Story {
  storyId: string;
  title?: string;
  description?: string;
  status: string;
  interiorPdfUri?: string;
  coverPdfUri?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChapterData {
  chapterNumber: number;
  content: string;
  imagePrompts?: string[];
  imageUri?: string;
}

export interface OutlineData {
  title?: string;
  author?: string;
  summary?: string;
  chapters?: Array<{
    title: string;
    description: string;
  }>;
}

export interface RunUpdateData {
  status?: StoryGenerationRun['status'];
  current_step?: string;  error_message?: string;
  started_at?: string;
  ended_at?: string;
  metadata?: Record<string, unknown>;
}
