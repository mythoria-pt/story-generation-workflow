// -----------------------------------------------------------------------------
// Shared Types - Environment-agnostic interfaces for business logic
// -----------------------------------------------------------------------------

export interface StoryOutline {
  id: string;
  title: string;
  synopsis: string;
  genre: string;
  targetAudience: string;
  chapters: ChapterOutline[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ChapterOutline {
  id: string;
  chapterNumber: number;
  title: string;
  summary: string;
  characterFocus: string[];
  plotPoints: string[];
  estimatedWordCount: number;
}

export interface ChapterContent {
  id: string;
  chapterNumber: number;
  title: string;
  content: string;
  imagePrompts: ImagePrompt[];
  wordCount: number;
  createdAt: Date;
}

export interface ImagePrompt {
  id: string;
  description: string;
  style: string;
  position: 'beginning' | 'middle' | 'end';
  priority: number;
}

export interface GeneratedImage {
  id: string;
  promptId: string;
  url: string;
  storageUri: string;
  width: number;
  height: number;
  createdAt: Date;
}

export interface StoryProduction {
  id: string;
  storyId: string;
  htmlContent: string;
  pdfUrl?: string;
  audioUrl?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
}

export interface WorkflowStep {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startTime?: Date;
  endTime?: Date;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface StoryGenerationWorkflow {
  id: string;
  storyId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  currentStep: string;
  steps: WorkflowStep[];
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowExecutionResult {
  executionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
  startTime: Date;
  endTime?: Date;
}
