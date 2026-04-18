// -----------------------------------------------------------------------------
// Shared Interfaces - Abstract interfaces for adapters
// -----------------------------------------------------------------------------

import { StoryOutline, ChapterContent, WorkflowExecutionResult } from './types.js';

// External Service Interfaces
export interface ITextGenerationService {
  generateStoryOutline(prompt: string): Promise<StoryOutline>;
  generateChapterContent(outline: StoryOutline, chapterNumber: number): Promise<ChapterContent>;
}

export interface IImageGenerationService {
  generateImage(prompt: string, style: string): Promise<Buffer>;
}

export interface IWorkflowService {
  executeWorkflow(workflowId: string, parameters: Record<string, unknown>): Promise<string>;
  getWorkflowExecution(executionId: string): Promise<WorkflowExecutionResult>;
}

export interface IAudioService {
  generateAudio(text: string, voice?: string): Promise<Buffer>;
}
