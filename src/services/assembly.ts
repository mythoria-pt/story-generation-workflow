/**
 * Assembly Service
 * Handles assembling story content into final formats (HTML, PDF)
 */

import { RunsService } from './runs.js';
import { StorageService } from './storage.js';
import { StoryService } from './story.js';
import { MessageService } from './message.js';
import { PDFService } from './pdf.js';
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
  private pdfService: PDFService;

  constructor() {
    this.runsService = new RunsService();
    this.storageService = new StorageService();
    this.storyService = new StoryService();
    this.pdfService = new PDFService();
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
      );      // Upload files to storage with correct bucket structure
      const htmlFilename = `${run.storyId}/story.html`;
      const pdfFilename = `${run.storyId}/story.pdf`;

      const [htmlUrl, pdfUrl] = await Promise.all([
        this.storageService.uploadFile(htmlFilename, Buffer.from(htmlContent), 'text/html'),
        this.storageService.uploadFile(pdfFilename, pdfContent, 'application/pdf')
      ]);

      // Update story with the HTML and PDF URIs in the database
      await this.storyService.updateStoryUris(run.storyId, {
        htmlUri: htmlUrl,
        pdfUri: pdfUrl
      });

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
        pageCount: result.metadata.pageCount,
        htmlUri: htmlUrl,
        pdfUri: pdfUrl
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
    const creditsMessage = await MessageService.getCreditsMessage(locale, author);    // Generate table of contents
    const tableOfContents = chapters.map((chapter) => 
      `<li class="mythoria-toc-item"><a href="#chapter-${chapter.number}" class="mythoria-toc-link">${chapter.title}</a></li>`
    ).join('');

    // Generate the HTML body content only (without body tag)
    const html = `
    <!-- Story Title -->
    <h1 class="mythoria-story-title">${title}</h1>

    <!-- Front Cover -->
    ${bookCoverImages.has('front') ? 
      `<div class="mythoria-front-cover">
        <img src="${bookCoverImages.get('front')}" alt="Book Front Cover" class="mythoria-cover-image" />
      </div>` : 
      ''
    }

    <!-- Page Break -->
    <div class="mythoria-page-break"></div>

    <!-- Author Dedicatory -->
    ${dedication ? `<div class="mythoria-dedicatory">${dedication}</div>` : ''}

    <!-- Author Name -->
    <div class="mythoria-author-name">by ${author}</div>

    <!-- Mythoria Message -->
    <div class="mythoria-message">
      <p class="mythoria-message-text">This story was imagined by <i class="mythoria-author-emphasis">${author}</i>.</p>
      <p class="mythoria-message-text">Crafted with:</p>
      <img src="https://storage.googleapis.com/mythoria-generated-stories/Mythoria-logo-white-512x336.jpg" alt="Mythoria Logo" class="mythoria-logo" />
    </div>

    <!-- Page Break -->
    <div class="mythoria-page-break"></div>

    <!-- Table of Contents -->
    <div class="mythoria-table-of-contents">
      <h2 class="mythoria-toc-title">Table of Contents</h2>
      <ul class="mythoria-toc-list">
        ${tableOfContents}
      </ul>
    </div>

    <!-- Page Break -->
    <div class="mythoria-page-break"></div>

    <!-- Chapters -->
    ${chapters.map(chapter => `
      <div class="mythoria-chapter" id="chapter-${chapter.number}">
        <h2 class="mythoria-chapter-title">${chapter.title}</h2>
        ${chapterImages.has(chapter.number) ?
          `<div class="mythoria-chapter-image">
            <img src="${chapterImages.get(chapter.number)}" alt="Chapter ${chapter.number} illustration" class="mythoria-chapter-img" />
          </div>` :
          ''
        }
        <div class="mythoria-chapter-content">
          ${chapter.content.split('\n').map((p: string) => p.trim() ? `<p class="mythoria-chapter-paragraph">${p}</p>` : '').join('')}
        </div>
      </div>
      <div class="mythoria-page-break"></div>
    `).join('')}

    <!-- Back Cover (if available) -->
    ${bookCoverImages.has('back') ? 
      `<div class="mythoria-back-cover">
        <img src="${bookCoverImages.get('back')}" alt="Book Back Cover" class="mythoria-cover-image" />
      </div>` : 
      ''
    }

    <!-- Credits -->
    <div class="mythoria-credits">
      <p class="mythoria-credits-text">${creditsMessage}</p>
    </div>`;

    return html;
  }
  
  private async createPDF(
    story: { title: string; description?: string; author?: string; dedicationMessage?: string | null; storyLanguage?: string }, 
    outline: Record<string, unknown>, 
    chapters: Array<{ number: number, content: string, title: string }>, 
    chapterImages: Map<number, string>, 
    bookCoverImages: Map<string, string>
  ): Promise<Buffer> {
    try {
      // Create the story HTML content using the same structure as createHTML
      const title = story.title;
      const author = story.author || outline.author as string || 'Mythoria AI';
      const dedication = story.dedicationMessage || null;
      const locale = story.storyLanguage || 'en-US';

      // Get localized credits message
      const creditsMessage = await MessageService.getCreditsMessage(locale, author);

      // Generate table of contents
      const tableOfContents = chapters.map((chapter) => 
        `<li class="mythoria-toc-item"><a href="#chapter-${chapter.number}" class="mythoria-toc-link">${chapter.title}</a></li>`
      ).join('');

      // Generate the HTML body content for PDF
      const storyContent = `
        <!-- Story Title -->
        <h1 class="mythoria-story-title">${title}</h1>

        <!-- Front Cover -->
        ${bookCoverImages.has('front') ? 
          `<div class="mythoria-front-cover">
            <img src="${bookCoverImages.get('front')}" alt="Book Front Cover" class="mythoria-cover-image" />
          </div>` : 
          ''
        }

        <!-- Page Break -->
        <div class="mythoria-page-break"></div>

        <!-- Author Dedicatory -->
        ${dedication ? `<div class="mythoria-dedicatory">${dedication}</div>` : ''}

        <!-- Author Name -->
        <div class="mythoria-author-name">by ${author}</div>

        <!-- Mythoria Message -->
        <div class="mythoria-message">
          <p class="mythoria-message-text">This story was imagined by <i class="mythoria-author-emphasis">${author}</i>.</p>
          <p class="mythoria-message-text">Crafted with:</p>
          <img src="Mythoria-logo-white-512x336.jpg" alt="Mythoria Logo" class="mythoria-logo" />
        </div>

        <!-- Page Break -->
        <div class="mythoria-page-break"></div>

        <!-- Table of Contents -->
        <div class="mythoria-table-of-contents">
          <h2 class="mythoria-toc-title">Table of Contents</h2>
          <ul class="mythoria-toc-list">
            ${tableOfContents}
          </ul>
        </div>

        <!-- Page Break -->
        <div class="mythoria-page-break"></div>

        <!-- Chapters -->
        ${chapters.map(chapter => `
          <div class="mythoria-chapter" id="chapter-${chapter.number}">
            <h2 class="mythoria-chapter-title">${chapter.title}</h2>
            ${chapterImages.has(chapter.number) ?
              `<div class="mythoria-chapter-image">
                <img src="${chapterImages.get(chapter.number)}" alt="Chapter ${chapter.number} illustration" class="mythoria-chapter-img" />
              </div>` :
              ''
            }
            <div class="mythoria-chapter-content">
              ${chapter.content.split('\n').map((p: string) => p.trim() ? `<p class="mythoria-chapter-paragraph">${p}</p>` : '').join('')}
            </div>
          </div>
          <div class="mythoria-page-break"></div>
        `).join('')}

        <!-- Back Cover (if available) -->
        ${bookCoverImages.has('back') ? 
          `<div class="mythoria-back-cover">
            <img src="${bookCoverImages.get('back')}" alt="Book Back Cover" class="mythoria-cover-image" />
          </div>` : 
          ''
        }

        <!-- Credits -->
        <div class="mythoria-credits">
          <p class="mythoria-credits-text">${creditsMessage}</p>
        </div>`;

      // Use the PDF service to generate the PDF with the proper template
      const pdfBuffer = await this.pdfService.generateStoryPDF(
        storyContent,
        title,
        locale.split('-')[0] // Convert 'en-US' to 'en'
      );

      return pdfBuffer;

    } catch (error) {
      logger.error('PDF creation failed', {
        error: error instanceof Error ? error.message : String(error),
        storyTitle: story.title
      });
      throw error;
    }
  }

}
