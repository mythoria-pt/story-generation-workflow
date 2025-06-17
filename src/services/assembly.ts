/**
 * Assembly Service
 * Handles assembling story content into final formats (HTML, PDF)
 */

import { RunsService } from './runs.js';
import { StorageService } from './storage.js';
import { StoryService } from './story.js';
import { MessageService } from './message.js';
import { logger } from '@/config/logger.js';
import { countWords } from '@/shared/utils.js';

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
  private storyService: StoryService;

  constructor() {
    this.runsService = new RunsService();
    this.storageService = new StorageService();
    this.storyService = new StoryService();
  }

  /**
   * Assemble a story into final formats
   */
  async assembleStory(runId: string): Promise<AssemblyResult> {
    try {
      logger.info('Starting story assembly', { runId });      // Get run details
      const run = await this.runsService.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      // Get story details from database
      const story = await this.storyService.getStory(run.storyId);
      if (!story) {
        throw new Error(`Story not found: ${run.storyId}`);
      }

      // Get outline
      const outlineStep = await this.runsService.getStepResult(runId, 'generate_outline');
      if (!outlineStep?.detailJson) {
        throw new Error('Outline not found');
      }
      
      // Get all chapters and images
      const steps = await this.runsService.getRunSteps(runId);
      const chapterSteps = steps.filter(step => step.stepName.startsWith('write_chapter_'));

      // Sort chapters by number
      const chapters = chapterSteps
        .map(step => ({
          number: parseInt(step.stepName.replace('write_chapter_', '')),
          content: (step.detailJson as Record<string, unknown>)?.chapter as string || '',
          title: `Chapter ${step.stepName.replace('write_chapter_', '')}`
        }))
        .sort((a, b) => a.number - b.number);

      // Get most recent images for each type from storage
      const imageUrls = await this.getLatestImages(run.storyId, chapters.length);
      
      // Map images to chapters
      const chapterImages = new Map<number, string>();
      for (let i = 1; i <= chapters.length; i++) {
        const chapterImageUrl = imageUrls.chapters[i];
        if (chapterImageUrl) {
          chapterImages.set(i, chapterImageUrl);
        }
      }

      // Map book cover images
      const bookCoverImages = new Map<string, string>();
      if (imageUrls.frontCover) {
        bookCoverImages.set('front', imageUrls.frontCover);
      }
      if (imageUrls.backCover) {
        bookCoverImages.set('back', imageUrls.backCover);
      }
        // Create HTML content
      const outlineData = (outlineStep.detailJson as Record<string, unknown>) || ({} as Record<string, unknown>);
      const htmlContent = await this.createHTML(
        story, // Use story from database
        outlineData,
        chapters,
        chapterImages,
        bookCoverImages
      );

      // Create PDF content (simplified - would need proper PDF library)
      const pdfContent = await this.createPDF(
        story, // Use story from database
        outlineData,
        chapters,
        chapterImages,
        bookCoverImages
      );

      // Upload files to storage with correct bucket structure
      const htmlFilename = `${run.storyId}/story.html`;
      const pdfFilename = `${run.storyId}/story.pdf`;

      const [htmlUrl, pdfUrl] = await Promise.all([
        this.storageService.uploadFile(htmlFilename, Buffer.from(htmlContent), 'text/html'),
        this.storageService.uploadFile(pdfFilename, pdfContent, 'application/pdf')
      ]);

      const result: AssemblyResult = {
        files: {
          html: htmlUrl,
          pdf: pdfUrl
        },        metadata: {
          title: story.title, // Use title from database
          wordCount: countWords(chapters.map(c => c.content).join(' ')),
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
  }
  
  /**
   * Get the latest images for each type from storage
   */
  private async getLatestImages(storyId: string, chapterCount: number): Promise<{
    frontCover?: string;
    backCover?: string;
    chapters: Record<number, string>;
  }> {
    try {
      const allFiles = await this.storageService.listFiles(`${storyId}/`);
      
      // Find the most recent images for each type
      let frontCover: string | undefined;
      let backCover: string | undefined;
      const chapters: Record<number, string> = {};

      // Sort files by modification time (most recent first)
      const sortedFiles = allFiles.sort((a, b) => {
        const aTime = a.timeCreated ? new Date(a.timeCreated).getTime() : 0;
        const bTime = b.timeCreated ? new Date(b.timeCreated).getTime() : 0;
        return bTime - aTime;
      });

      for (const file of sortedFiles) {
        if (!file.name) continue;

        // Check for front cover
        if (!frontCover && file.name.includes('front_cover') && file.name.match(/\.(jpg|jpeg|png|webp)$/i)) {
          frontCover = await this.storageService.getPublicUrl(file.name);
        }
        
        // Check for back cover
        if (!backCover && file.name.includes('back_cover') && file.name.match(/\.(jpg|jpeg|png|webp)$/i)) {
          backCover = await this.storageService.getPublicUrl(file.name);
        }
          // Check for chapter images
        const chapterMatch = file.name.match(/chapter_(\d+).*\.(jpg|jpeg|png|webp)$/i);
        if (chapterMatch && chapterMatch[1]) {
          const chapterNum = parseInt(chapterMatch[1]);
          if (chapterNum >= 1 && chapterNum <= chapterCount && !chapters[chapterNum]) {
            chapters[chapterNum] = await this.storageService.getPublicUrl(file.name);
          }
        }
      }      const result: { frontCover?: string; backCover?: string; chapters: Record<number, string> } = { chapters };
      if (frontCover) result.frontCover = frontCover;
      if (backCover) result.backCover = backCover;
      
      return result;
    } catch (error) {
      logger.warn('Failed to get latest images from storage', { error, storyId });
      return { chapters: {} };
    }
  }  private async createHTML(
    story: { title: string; description?: string; author?: string; dedicationMessage?: string | null; storyLanguage?: string }, 
    outline: Record<string, unknown>, 
    chapters: Array<{ number: number, content: string, title: string }>, 
    chapterImages: Map<number, string>, 
    bookCoverImages: Map<string, string>
  ): Promise<string> {
    const title = story.title; // Use title from database
    const author = story.author || outline.author as string || 'Mythoria AI';
    const dedication = story.dedicationMessage || null;
    const locale = story.storyLanguage || 'en-US';

    // Get localized credits message
    const creditsMessage = await MessageService.getCreditsMessage(locale, author);

    const html = `
<!DOCTYPE html>
<html lang="${locale.split('-')[0]}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body { font-family: Georgia, serif; line-height: 1.6; margin: 0; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .title { text-align: center; font-size: 2.5em; margin-bottom: 0.5em; }
        .dedication { text-align: center; font-style: italic; font-size: 1.1em; color: #555; margin-bottom: 1em; }
        .author { text-align: center; font-size: 1.2em; color: #666; margin-bottom: 2em; }
        .chapter { margin-bottom: 3em; page-break-before: always; }
        .chapter-title { font-size: 1.8em; margin-bottom: 1em; border-bottom: 2px solid #333; }        .chapter-image { text-align: center; margin: 2em 0; }
        .chapter-image img { max-width: 100%; height: auto; border-radius: 8px; }
        .book-cover { text-align: center; margin: 2em 0; }
        .book-cover img { max-width: 400px; height: auto; border-radius: 8px; }
        .synopsis { font-style: italic; margin-bottom: 2em; padding: 1em; background: #f5f5f5; }
        .credits { text-align: center; font-size: 0.9em; color: #777; margin-top: 3em; padding-top: 2em; border-top: 1px solid #ddd; }
        .credits a { color: #007bff; text-decoration: none; }
        .credits a:hover { text-decoration: underline; }
    </style>
</head>
<body>    <div class="container">
        ${bookCoverImages.has('front') ? 
          `<div class="book-cover">
            <img src="${bookCoverImages.get('front')}" alt="Book Front Cover" />
          </div>` : 
          ''
        }
        
        <h1 class="title">${title}</h1>
        ${dedication ? `<p class="dedication">${dedication}</p>` : ''}
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
        
        ${bookCoverImages.has('back') ? 
          `<div class="book-cover">
            <img src="${bookCoverImages.get('back')}" alt="Book Back Cover" />
          </div>` : 
          ''
        }
        
        <div class="credits">
            <p>${creditsMessage}</p>
        </div>
    </div>
</body>
</html>`;

    return html;
  }  private async createPDF(
    story: { title: string; description?: string; author?: string; dedicationMessage?: string | null; storyLanguage?: string }, 
    outline: Record<string, unknown>, 
    chapters: Array<{ number: number, content: string, title: string }>, 
    _chapterImages: Map<number, string>, 
    _bookCoverImages: Map<string, string>
  ): Promise<Buffer> {    // This is a placeholder implementation
    // In production, you'd use a library like puppeteer or jsPDF
    const author = story.author || outline.author as string || 'Mythoria AI';
    const dedication = story.dedicationMessage || null;
    const locale = story.storyLanguage || 'en-US';

    // Get localized credits message
    const creditsMessage = await MessageService.getCreditsMessage(locale, author);

    const content = `
${story.title}
${dedication ? `\n${dedication}\n` : ''}
by ${author}

${story.description || outline.synopsis as string || ''}

${chapters.map(chapter => `
${chapter.title}

${chapter.content}
`).join('\n')}

---

${creditsMessage}
`;

    return Buffer.from(content, 'utf-8');
  }

}
