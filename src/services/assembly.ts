/**
 * Assembly Service
 * Handles assembling story content into final formats (HTML, PDF)
 */

import { RunsService } from './runs.js';
import { StorageService } from './storage.js';
import { logger } from '@/config/logger.js';

export interface AssemblyResult {
  files: {
    html?: string;
    pdf?: string;
  };
  metadata: {
    title: string;
    wordCount: number;
    pageCount: number;
    generatedAt: string;
  };
}

export class AssemblyService {
  private runsService: RunsService;
  private storageService: StorageService;

  constructor() {
    this.runsService = new RunsService();
    this.storageService = new StorageService();
  }

  /**
   * Assemble a story into final formats
   */
  async assembleStory(runId: string): Promise<AssemblyResult> {
    try {
      logger.info('Starting story assembly', { runId });

      // Get run details
      const run = await this.runsService.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      // Get outline
      const outlineStep = await this.runsService.getStepResult(runId, 'generate_outline');
      if (!outlineStep?.detailJson) {
        throw new Error('Outline not found');
      }

      // Get all chapters
      const steps = await this.runsService.getRunSteps(runId);
      const chapterSteps = steps.filter(step => step.stepName.startsWith('write_chapter_'));
      const imageSteps = steps.filter(step => step.stepName.startsWith('generate_image_'));      // Sort chapters by number
      const chapters = chapterSteps
        .map(step => ({
          number: parseInt(step.stepName.replace('write_chapter_', '')),
          content: (step.detailJson as Record<string, unknown>)?.chapter as string || '',
          title: `Chapter ${step.stepName.replace('write_chapter_', '')}`
        }))
        .sort((a, b) => a.number - b.number);

      // Map images to chapters
      const chapterImages = new Map<number, string>();
      for (const imageStep of imageSteps) {
        const chapterNum = parseInt(imageStep.stepName.replace('generate_image_', ''));
        const imageUrl = (imageStep.detailJson as Record<string, unknown>)?.imageUrl as string;
        if (imageUrl) {
          chapterImages.set(chapterNum, imageUrl);
        }
      }      // Create HTML content
      const outlineData = (outlineStep.detailJson as Record<string, unknown>) || ({} as Record<string, unknown>);
      const htmlContent = this.createHTML(
        outlineData,
        chapters,
        chapterImages
      );      // Create PDF content (simplified - would need proper PDF library)
      const pdfContent = this.createPDF(
        outlineData,
        chapters,
        chapterImages
      );

      // Upload files to storage
      const htmlFilename = `stories/${runId}/story.html`;
      const pdfFilename = `stories/${runId}/story.pdf`;

      const [htmlUrl, pdfUrl] = await Promise.all([
        this.storageService.uploadFile(htmlFilename, Buffer.from(htmlContent), 'text/html'),
        this.storageService.uploadFile(pdfFilename, pdfContent, 'application/pdf')
      ]);

      const result: AssemblyResult = {
        files: {
          html: htmlUrl,
          pdf: pdfUrl
        },        metadata: {
          title: (outlineStep.detailJson as Record<string, unknown>)?.title as string || 'Untitled Story',
          wordCount: this.countWords(chapters.map(c => c.content).join(' ')),
          pageCount: Math.ceil(chapters.length / 2), // Rough estimate
          generatedAt: new Date().toISOString()
        }
      };

      logger.info('Story assembly completed', {
        runId,
        wordCount: result.metadata.wordCount,
        pageCount: result.metadata.pageCount
      });

      return result;
    } catch (error) {
      logger.error('Story assembly failed', {
        error: error instanceof Error ? error.message : String(error),
        runId
      });
      throw error;
    }
  }  private createHTML(outline: Record<string, unknown>, chapters: Array<{number: number, content: string, title: string}>, chapterImages: Map<number, string>): string {
    const title = outline.title as string || 'Untitled Story';
    const author = outline.author as string || 'Mythoria AI';
    
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body { font-family: Georgia, serif; line-height: 1.6; margin: 0; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .title { text-align: center; font-size: 2.5em; margin-bottom: 0.5em; }
        .author { text-align: center; font-size: 1.2em; color: #666; margin-bottom: 2em; }
        .chapter { margin-bottom: 3em; page-break-before: always; }
        .chapter-title { font-size: 1.8em; margin-bottom: 1em; border-bottom: 2px solid #333; }
        .chapter-image { text-align: center; margin: 2em 0; }
        .chapter-image img { max-width: 100%; height: auto; border-radius: 8px; }
        .synopsis { font-style: italic; margin-bottom: 2em; padding: 1em; background: #f5f5f5; }
    </style>
</head>
<body>
    <div class="container">
        <h1 class="title">${title}</h1>
        <p class="author">by ${author}</p>
        
        ${outline.synopsis ? `<div class="synopsis">${outline.synopsis}</div>` : ''}
        
        ${chapters.map(chapter => `
            <div class="chapter">
                <h2 class="chapter-title">${chapter.title}</h2>
                ${chapterImages.has(chapter.number) ? 
                  `<div class="chapter-image"><img src="${chapterImages.get(chapter.number)}" alt="Chapter ${chapter.number} illustration" /></div>` : 
                  ''
                }                <div class="chapter-content">
                    ${chapter.content.split('\n').map((p: string) => p.trim() ? `<p>${p}</p>` : '').join('')}
                </div>
            </div>
        `).join('')}
    </div>
</body>
</html>`;

    return html;
  }
  private createPDF(outline: Record<string, unknown>, chapters: Array<{number: number, content: string, title: string}>, _chapterImages: Map<number, string>): Buffer {
    // This is a placeholder implementation
    // In production, you'd use a library like puppeteer or jsPDF
    const content = `
${outline.title as string || 'Untitled Story'}
by ${outline.author as string || 'Mythoria AI'}

${outline.synopsis as string || ''}

${chapters.map(chapter => `
${chapter.title}

${chapter.content}
`).join('\n')}
`;

    return Buffer.from(content, 'utf-8');
  }

  private countWords(text: string): number {
    return text.split(/\s+/).filter(word => word.length > 0).length;
  }
}
