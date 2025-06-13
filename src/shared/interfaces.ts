// -----------------------------------------------------------------------------
// Shared Interfaces - Abstract interfaces for adapters
// -----------------------------------------------------------------------------

import { 
  StoryOutline, 
  ChapterContent, 
  GeneratedImage, 
  StoryGenerationWorkflow,
  WorkflowExecutionResult
} from './types.js';

// Database Repository Interfaces
export interface IStoryRepository {
  findById(id: string): Promise<StoryOutline | null>;
  create(story: Omit<StoryOutline, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoryOutline>;
  update(id: string, updates: Partial<StoryOutline>): Promise<StoryOutline>;
  delete(id: string): Promise<void>;
}

export interface IChapterRepository {
  findByStoryId(storyId: string): Promise<ChapterContent[]>;
  create(chapter: Omit<ChapterContent, 'id' | 'createdAt'>): Promise<ChapterContent>;
  update(id: string, updates: Partial<ChapterContent>): Promise<ChapterContent>;
  delete(id: string): Promise<void>;
}

export interface IImageRepository {
  findByChapterId(chapterId: string): Promise<GeneratedImage[]>;
  create(image: Omit<GeneratedImage, 'id' | 'createdAt'>): Promise<GeneratedImage>;
  delete(id: string): Promise<void>;
}

export interface IWorkflowRepository {
  findById(id: string): Promise<StoryGenerationWorkflow | null>;
  create(workflow: Omit<StoryGenerationWorkflow, 'id' | 'createdAt' | 'updatedAt'>): Promise<StoryGenerationWorkflow>;
  update(id: string, updates: Partial<StoryGenerationWorkflow>): Promise<StoryGenerationWorkflow>;
  findByStatus(status: string): Promise<StoryGenerationWorkflow[]>;
}

// External Service Interfaces
export interface ITextGenerationService {
  generateStoryOutline(prompt: string): Promise<StoryOutline>;
  generateChapterContent(outline: StoryOutline, chapterNumber: number): Promise<ChapterContent>;
}

export interface IImageGenerationService {
  generateImage(prompt: string, style: string): Promise<Buffer>;
}

export interface IStorageService {
  uploadFile(fileName: string, content: Buffer, mimeType: string): Promise<string>;
  getFileUrl(fileName: string): Promise<string>;
  deleteFile(fileName: string): Promise<void>;
}

export interface IWorkflowService {
  executeWorkflow(workflowId: string, parameters: Record<string, unknown>): Promise<string>;
  getWorkflowExecution(executionId: string): Promise<WorkflowExecutionResult>;
}

export interface IPdfService {
  generatePdf(htmlContent: string): Promise<Buffer>;
}

export interface IAudioService {
  generateAudio(text: string, voice?: string): Promise<Buffer>;
}
