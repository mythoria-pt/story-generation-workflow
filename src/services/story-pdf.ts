/**
 * Story PDF Service
 * Handles PDF generation for stories based on their HTML content and target audience
 */

import * as path from 'path';
import { StorageService } from './storage';
import { StoryService } from './story';
import { PDFService } from './pdf';
import { logger } from '@/config/logger';
import { countWords } from '@/shared/utils';
import { Story } from '@/db/schema/stories';

// In CommonJS, __filename and __dirname are global variables

export interface StoryPDFResult {
  pdfUri: string;
  version: string;
  metadata: {
    title: string;
    wordCount: number;
    pageCount: number;
    generatedAt: string;
  };
}

export class StoryPDFService {
  private storageService: StorageService;
  private storyService: StoryService;

  // Mapping of graphical styles to logo URLs
  private static readonly LOGO_MAPPING: Record<string, string> = {
    'cartoon': 'https://mythoria.pt/images/logo/cartoon.jpg',
    'realistic': 'https://mythoria.pt/images/logo/realistic.jpg',
    'watercolor': 'https://mythoria.pt/images/logo/watercolor.jpg',
    'digital_art': 'https://mythoria.pt/images/logo/digital_art.jpg',
    'hand_drawn': 'https://mythoria.pt/images/logo/hand_drawn.jpg',
    'minimalist': 'https://mythoria.pt/images/logo/minimalist.jpg',
    'vintage': 'https://mythoria.pt/images/logo/vintage.jpg',
    'comic_book': 'https://mythoria.pt/images/logo/comic_book.jpg',
    'anime': 'https://mythoria.pt/images/logo/anime.jpg',
    'pixar_style': 'https://mythoria.pt/images/logo/pixar_style.jpg',
    'disney_style': 'https://mythoria.pt/images/logo/disney_style.jpg',
    'sketch': 'https://mythoria.pt/images/logo/sketch.jpg',
    'oil_painting': 'https://mythoria.pt/images/logo/oil_painting.jpg',
    'colored_pencil': 'https://mythoria.pt/images/logo/colored_pencil.jpg'
  };

  // Default logo URL as fallback
  private static readonly DEFAULT_LOGO_URL = 'https://mythoria.pt/images/logo/anime.jpg';

  constructor() {
    this.storageService = new StorageService();
    this.storyService = new StoryService();
  }

  /**
   * Generate PDF for a story by storyId
   */
  async generateStoryPDF(storyId: string): Promise<StoryPDFResult> {
    try {
      logger.info('Starting PDF generation for story', { storyId });

      // 1. Load the story from the database
      const story = await this.storyService.getStory(storyId);
      if (!story) {
        throw new Error(`Story not found: ${storyId}`);
      }

      if (!story.htmlUri) {
        throw new Error(`Story HTML not found: ${storyId}`);
      }
      
      // 2. Load the story HTML from Google Storage
      const htmlContent = await this.loadStoryHTML(story.htmlUri);

      // 3. Update the Mythoria logo based on graphical style
      const logoUrl = this.getLogoUrl(story.graphicalStyle);
      const updatedHTML = this.updateMythoriaLogo(htmlContent, logoUrl);

      // 4. Generate PDF with the appropriate template for target audience
      const templatePath = this.getTemplatePath(story.targetAudience);
      const pdfBuffer = await this.generatePDFFromHTML(updatedHTML, story, templatePath);

      // 5. Determine the next version number
      const nextVersion = await this.getNextPDFVersion(storyId);

      // 6. Store PDF on Google Storage
      const pdfFilename = `${storyId}/story_v${nextVersion.padStart(3, '0')}.pdf`;
      const pdfUri = await this.storageService.uploadFile(pdfFilename, pdfBuffer, 'application/pdf');

      // 7. Update the database with the new PDF URI
      await this.storyService.updateStoryUris(storyId, {
        pdfUri: pdfUri
      });

      const result: StoryPDFResult = {
        pdfUri,
        version: nextVersion,
        metadata: {
          title: story.title,
          wordCount: countWords(updatedHTML),
          pageCount: Math.ceil(updatedHTML.length / 3000), // Rough estimate
          generatedAt: new Date().toISOString()
        }
      };

      logger.info('PDF generation completed', {
        storyId,
        version: nextVersion,
        pdfUri,
        wordCount: result.metadata.wordCount
      });

      return result;
    } catch (error) {
      logger.error('PDF generation failed', {
        error: error instanceof Error ? error.message : String(error),
        storyId
      });
      throw error;
    }
  }
  /**
   * Load story HTML content from Google Storage
   */
  private async loadStoryHTML(htmlUri: string): Promise<string> {
    try {
      // Extract the file path from the URI
      const urlParts = htmlUri.split('/');
      const fileName = urlParts[urlParts.length - 1];
      const storyId = urlParts[urlParts.length - 2];
      const filePath = `${storyId}/${fileName}`;

      // Download the file content
      const htmlContent = await this.storageService.downloadFile(filePath);
      return htmlContent;
    } catch (error) {
      logger.error('Failed to load story HTML', {
        error: error instanceof Error ? error.message : String(error),
        htmlUri
      });
      throw new Error(`Failed to load story HTML from: ${htmlUri}`);
    }  }

  /**
   * Get the logo URL based on graphical style
   */
  private getLogoUrl(graphicalStyle: string | null): string {
    if (!graphicalStyle) {
      return StoryPDFService.DEFAULT_LOGO_URL;
    }

    return StoryPDFService.LOGO_MAPPING[graphicalStyle] || StoryPDFService.DEFAULT_LOGO_URL;
  }

  /**
   * Update the Mythoria logo in the HTML content
   */
  private updateMythoriaLogo(htmlContent: string, logoUrl: string): string {
    // Replace the logo URL in the Mythoria message section
    return htmlContent.replace(
      /(<img[^>]+class="mythoria-logo"[^>]+src=")[^"]*("[^>]*>)/g,
      `$1${logoUrl}$2`
    );
  }

  /**
   * Get the template file path based on target audience
   */
  private getTemplatePath(targetAudience: string | null): string {
    const templatesDir = path.join(__dirname, '../templates');
    
    if (!targetAudience) {
      return path.join(templatesDir, 'all_ages.html');
    }

    // Map target audience to template file
    const templateFile = `${targetAudience}.html`;
    const templatePath = path.join(templatesDir, templateFile);

    // Return the template path
    return templatePath;
  }  /**
   * Generate PDF directly from HTML content
   */
  private async generatePDFFromHTML(htmlContent: string, story: Partial<Story> & { author?: string }, templatePath: string): Promise<Buffer> {
    try {
      // Check if the template exists, if not use fallback
      const fs = await import('fs/promises');
      let finalTemplatePath = templatePath;
        try {
        await fs.access(templatePath);
        logger.info('Using target audience specific template', { 
          targetAudience: story.targetAudience,
          templatePath 
        });
      } catch {
        // Template doesn't exist, use fallback
        finalTemplatePath = path.join(__dirname, '../templates/all_ages.html');
        logger.warn('Template not found, using fallback', { 
          targetAudience: story.targetAudience, 
          requestedTemplate: templatePath,
          fallbackTemplate: finalTemplatePath
        });
      }

      // Create a PDF service instance with the appropriate template
      const pdfService = new PDFService(finalTemplatePath);

      // The HTML content is already a complete document, so we can use a simple approach
      // We'll create a minimal wrapper that just provides the content to the PDF service
      const storyContentOnly = this.extractStoryContentFromHTML(htmlContent);

      // Use the PDF service to generate the PDF
      const pdfBuffer = await pdfService.generateStoryPDF(
        storyContentOnly,
        story.title || 'Untitled Story',
        story.storyLanguage?.split('-')[0] || 'en'
      );

      return pdfBuffer;
    } catch (error) {
      logger.error('Failed to generate PDF from HTML', {
        error: error instanceof Error ? error.message : String(error),
        storyTitle: story.title,
        templatePath
      });
      throw error;
    }
  }

  /**
   * Extract just the story content from the full HTML document
   * This removes the HTML structure and keeps only the story text and formatting
   */
  private extractStoryContentFromHTML(htmlContent: string): string {
    // For now, we'll return the full HTML since the PDF service can handle it
    // In the future, we might want to extract just the body content
    return htmlContent;
  }

  /**
   * Get the next PDF version number for a story
   */
  private async getNextPDFVersion(storyId: string): Promise<string> {
    try {
      // List all files in the story folder
      const files = await this.storageService.listFiles(`${storyId}/`);
      
      // Find existing PDF versions
      const pdfVersions: number[] = [];
      files.forEach(file => {
        if (file.name) {
          const match = file.name.match(/story_v(\d+)\.pdf$/);
          if (match && match[1]) {
            pdfVersions.push(parseInt(match[1], 10));
          }
        }
      });

      // Get the next version number
      const maxVersion = pdfVersions.length > 0 ? Math.max(...pdfVersions) : 0;
      const nextVersion = maxVersion + 1;

      return nextVersion.toString();
    } catch (error) {
      logger.error('Failed to determine next PDF version', {
        error: error instanceof Error ? error.message : String(error),
        storyId
      });
      // If we can't determine the version, start with version 1
      return '1';
    }
  }
}
