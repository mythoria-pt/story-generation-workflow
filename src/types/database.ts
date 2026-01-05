/**
 * Type definitions for database operations and API responses
 */

export interface StoryGenerationRun {
  runId: string;
  storyId: string;
  gcpWorkflowExecution?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';
  currentStep?: string;
  errorMessage?: string;
  startedAt?: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
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

export type OutlineTargetAudience =
  | 'children_0-2'
  | 'children_3-6'
  | 'children_7-10'
  | 'children_11-14'
  | 'young_adult_15-17'
  | 'adult_18+'
  | 'all_ages';

export interface OutlineData {
  bookTitle: string;
  'target-audience': OutlineTargetAudience;
  bookCoverPrompt: string;
  bookBackCoverPrompt: string;
  bookCoverCharacters: string[];
  bookBackCoverCharacters: string[];
  synopses: string;
  characters: Array<{
    characterId?: string | null;
    name: string;
    type?: string;
    age?: string;
    traits?: string[];
    characteristics?: string;
    physicalDescription?: string;
    role?: string;
  }>;
  chapters: Array<{
    chapterNumber: number;
    chapterTitle: string;
    chapterSynopses: string;
    chapterPhotoPrompt: string;
    charactersInScene: string[];
  }>;
}

export interface RunUpdateData {
  status?: StoryGenerationRun['status'];
  current_step?: string;
  error_message?: string;
  started_at?: string;
  ended_at?: string;
  metadata?: Record<string, unknown>;
}
