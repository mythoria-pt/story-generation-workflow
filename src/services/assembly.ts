/**
 * Assembly Service
 * Handles assembling story content into final formats (HTML, PDF)
 * 
 * NOTE: This service is no longer part of the main story generation workflow
 * as chapters are now stored directly in the database. However, it remains
 * available for future PDF generation functionality.
 */

import { RunsService } from './runs.js';
import { StorageService } from './storage.js';
import { StoryService } from './story.js';
import { MessageService } from './message.js';
import { logger } from '@/config/logger.js';
import { countWords } from '@/shared/utils.js';

// No encoding functions needed as we're preserving all HTML

export interface AssemblyResult {
  files: {
    html?: string;
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
      
      // Extract outline data
      const outlineData = (outlineStep.detailJson as Record<string, unknown>) || ({} as Record<string, unknown>);
        // Get all chapter steps to retrieve content
      const steps = await this.runsService.getRunSteps(runId);
      const chapterSteps = steps.filter(step => step.stepName.startsWith('write_chapter_'));

      // Create a map of chapter content by chapter number
      const chapterContentMap = new Map<number, string>();
      chapterSteps.forEach(step => {
        const chapterNumber = parseInt(step.stepName.replace('write_chapter_', ''));
        const content = (step.detailJson as Record<string, unknown>)?.chapter as string || '';
        chapterContentMap.set(chapterNumber, content);
      });

      // Extract chapters from outline data (this contains the actual chapter titles)
      const outlineChapters = (outlineData.chapters as Array<{ chapterNumber: number; chapterTitle: string }>) || [];
      const chapters = outlineChapters
        .map(outlineChapter => ({
          number: outlineChapter.chapterNumber,
          content: chapterContentMap.get(outlineChapter.chapterNumber) || '',
          title: outlineChapter.chapterTitle || `Chapter ${outlineChapter.chapterNumber}`
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
      const htmlContent = await this.createHTML(
        story, // Use story from database
        outlineData,
        chapters,
        chapterImages,
        bookCoverImages
      );
      
      // Upload HTML file to storage
      const htmlFilename = `${run.storyId}/story_v001.html`;
      const htmlUrl = await this.storageService.uploadFile(htmlFilename, Buffer.from(htmlContent), 'text/html');

      // Update story with the HTML URI in the database
      await this.storyService.updateStoryUris(run.storyId, {
        htmlUri: htmlUrl
      });

      const result: AssemblyResult = {
        files: {
          html: htmlUrl
        },
        metadata: {
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
        htmlUri: htmlUrl
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
        if (!frontCover && file.name.includes('frontcover') && file.name.match(/\.(jpg|jpeg|png|webp)$/i)) {
          frontCover = await this.storageService.getPublicUrl(file.name);
        }
        
        // Check for back cover
        if (!backCover && file.name.includes('backcover') && file.name.match(/\.(jpg|jpeg|png|webp)$/i)) {
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
      }
      
      const result: { frontCover?: string; backCover?: string; chapters: Record<number, string> } = { chapters };
      if (frontCover) result.frontCover = frontCover;
      if (backCover) result.backCover = backCover;
      
      return result;
    } catch (error) {
      logger.warn('Failed to get latest images from storage', { error, storyId });
      return { chapters: {} };
    }
  }
  
  private async createHTML(
    story: { title: string; description?: string; author?: string; dedicationMessage?: string | null; storyLanguage?: string; graphicalStyle?: string | null }, 
    outline: Record<string, unknown>, 
    chapters: Array<{ number: number, content: string, title: string }>, 
    chapterImages: Map<number, string>, 
    bookCoverImages: Map<string, string>
  ): Promise<string> {
    const title = story.title; // Use title from database
    const author = story.author || outline.author as string || 'Mythoria AI';
    const dedication = story.dedicationMessage || null;
    const locale = story.storyLanguage || 'en-US';
    const logoUrl = this.getLogoUrl(story.graphicalStyle);

    // Get localized messages
    const creditsMessage = await MessageService.getCreditsMessage(locale, author);
    const tableOfContentsTitle = await MessageService.getTableOfContentsTitle(locale);
    const storyImaginedByMessage = await MessageService.getStoryImaginedByMessage(locale, author);
    const craftedWithMessage = await MessageService.getCraftedWithMessage(locale);
    // Generate table of contents
    const tableOfContents = chapters.map((chapter) => 
      `<li class="mythoria-toc-item"><a href="#chapter-${chapter.number}" class="mythoria-toc-link">${chapter.number}. ${chapter.title}</a></li>`
    ).join('');

    // Generate content only (no html/head/body tags)
    const html = `
   
<!-- Story Title -->
<h1 class="mythoria-story-title">${title}</h1>
<!-- Front Cover -->
${bookCoverImages.has('front') ? 
  `<div class="mythoria-front-cover">
    <img src="${bookCoverImages.get('front')}" alt="Book Front Cover" class="mythoria-cover-image" />
  </div>
  
  <!-- Page Break -->
  <div class="mythoria-page-break"></div>` : 
  ''
}
  
<!-- Author Dedicatory -->
${dedication ? `<div class="mythoria-dedicatory">
  ${dedication}
  <div class="mythoria-author-name">- <em>${author}</em></div>
</div>` : ''}
<!-- Mythoria Message -->
<div class="mythoria-message">
  <p class="mythoria-message-text">${storyImaginedByMessage}</p>
  <p class="mythoria-message-text">${craftedWithMessage}</p>
  <img src="${logoUrl}" alt="Mythoria Logo" class="mythoria-logo" />
</div>
<!-- Page Break -->
<div class="mythoria-page-break"></div>
<!-- Table of Contents -->
<div class="mythoria-table-of-contents">
  <h2 class="mythoria-toc-title">${tableOfContentsTitle}</h2>
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
      ${this.cleanChapterContent(chapter.content).split('\n').map((p: string) => p.trim() ? `<p class="mythoria-chapter-paragraph">${p}</p>` : '').join('')}
    </div>
  </div>
  <div class="mythoria-page-break"></div>
`).join('')}
<!-- Credits -->
<div class="mythoria-credits">
  <p class="mythoria-credits-text">${creditsMessage}</p>
</div>
<!-- Back Cover (if available) -->
${bookCoverImages.has('back') ? 
  `<div class="mythoria-page-break"></div>
  <div class="mythoria-back-cover">
    <img src="${bookCoverImages.get('back')}" alt="Book Back Cover" class="mythoria-cover-image" />
  </div>` : 
  ''
}`;

    return html;
  }

  /**
   * Get the appropriate Mythoria logo URL based on the story's graphical style
   * @param graphicalStyle - The graphical style from the story database field
   * @returns The complete URL to the appropriate logo image
   */
  private getLogoUrl(graphicalStyle?: string | null): string {
    const baseUrl = 'https://mythoria.pt/images/logo/';
    
    if (!graphicalStyle) {
      return `${baseUrl}Logo.jpg`;
    }

    // Map graphical styles to logo filenames (case-insensitive)
    // Based on the graphicalStyleEnum from the database schema
    const styleMapping: Record<string, string> = {
      'anime': 'anime.jpg',
      'cartoon': 'cartoon.jpg',
      'colored_pencil': 'colored_pencil.jpg',
      'comic_book': 'comic_book.jpg',
      'digital_art': 'digital_art.jpg',
      'disney_style': 'disney.jpg',
      'hand_drawn': 'hand_drawn.jpg',
      'minimalist': 'minimalist.jpg',
      'oil_painting': 'oil-painting.jpg',
      'pixar_style': 'pixar.jpg',
      'realistic': 'realistic.jpg',
      'sketch': 'sketch.jpg',
      'vintage': 'vintage.jpg',
      'watercolor': 'digital_art.png' // Using PNG variant for watercolor
    };

    const normalizedStyle = graphicalStyle.toLowerCase();
    const logoFile = styleMapping[normalizedStyle] || 'Logo.jpg';
    
    return `${baseUrl}${logoFile}`;
  }

  /**
   * Clean chapter content by removing markdown code block markers
   * @param content - The original chapter content
   * @returns The cleaned chapter content without markdown code blocks
   */
  private cleanChapterContent(content: string): string {
    // Remove any triple backtick code block markers (```html, ```, etc)
    let cleanedContent = content;
    
    // Remove opening markdown code block with or without language specification
    cleanedContent = cleanedContent.replace(/^\s*```(?:html|javascript|js|typescript|ts)?\s*/i, '');
    
    // Remove closing markdown code block
    cleanedContent = cleanedContent.replace(/\s*```\s*$/i, '');

    // Look for intermediate code blocks as well
    cleanedContent = cleanedContent.replace(/```(?:html|javascript|js|typescript|ts)?\s*/gi, '');
    cleanedContent = cleanedContent.replace(/\s*```/gi, '');

    return cleanedContent;
  }

}
