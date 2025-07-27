/**
 * PDF Service
 * Handles HTML templating and PDF generation using puppeteer-html-pdf
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import PuppeteerHTMLPDF from 'puppeteer-html-pdf';
import { logger } from '@/config/logger';

// In CommonJS, __filename and __dirname are global variables

export interface PDFGenerationOptions {
  format?: 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal';
  margin?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
  printBackground?: boolean;
  displayHeaderFooter?: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  landscape?: boolean;
}

export class PDFService {
  private templatePath: string;

  constructor(templatePath?: string) {
    // Use provided template path or default to all_ages.html
    this.templatePath = templatePath || path.join(__dirname, '../templates/all_ages.html');
  }

  /**
   * Generate PDF from story HTML content
   */
  async generateStoryPDF(
    storyContent: string,
    title: string,
    language: string = 'en',
    options: PDFGenerationOptions = {}
  ): Promise<Buffer> {
    try {
      logger.info('Starting PDF generation', { title, language });

      // Read the HTML template
      const template = await this.loadTemplate();

      // Apply template variables
      const finalHTML = this.applyTemplate(template, {
        title,
        language,
        content: storyContent
      });

      // Default PDF options optimized for story printing
      const defaultOptions: PDFGenerationOptions = {
        format: 'A4',
        margin: {
          top: '2cm',
          right: '2.5cm',
          bottom: '3cm',
          left: '2.5cm'
        },
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: `
          <div style="font-size: 10pt; color: #666; text-align: center; width: 100%; margin-top: 1cm;">
            <span class="title">${title}</span>
          </div>
        `,
        footerTemplate: `
          <div style="font-size: 10pt; color: #666; text-align: center; width: 100%;">
            <span class="pageNumber"></span>
          </div>
        `,
        landscape: false
      };
      
      // Merge with provided options
      const pdfOptions = { ...defaultOptions, ...options };

      // Create PDF generator instance
      const pdfGenerator = new PuppeteerHTMLPDF();
      // Set options for the PDF generator
      await pdfGenerator.setOptions({
        format: pdfOptions.format || 'A4',
        margin: pdfOptions.margin || {
          top: '2cm',
          right: '2.5cm',
          bottom: '3cm',
          left: '2.5cm'
        },
        printBackground: pdfOptions.printBackground ?? true,
        displayHeaderFooter: pdfOptions.displayHeaderFooter ?? true,
        headerTemplate: pdfOptions.headerTemplate || '',
        footerTemplate: pdfOptions.footerTemplate || '',
        landscape: pdfOptions.landscape ?? false,
        preferCSSPageSize: true,
        timeout: 60000
      });

      // Convert HTML to PDF
      const pdfBuffer = await pdfGenerator.create(finalHTML);

      logger.info('PDF generation completed successfully', { 
        title, 
        bufferSize: pdfBuffer.length 
      });

      return pdfBuffer;

    } catch (error) {
      logger.error('PDF generation failed', {
        error: error instanceof Error ? error.message : String(error),
        title,
        language
      });
      throw new Error(`Failed to generate PDF: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Load HTML template from file
   */
  private async loadTemplate(): Promise<string> {
    try {
      const template = await fs.readFile(this.templatePath, 'utf-8');
      return template;
    } catch (error) {
      logger.error('Failed to load HTML template', {
        error: error instanceof Error ? error.message : String(error),
        templatePath: this.templatePath
      });
      throw new Error(`Failed to load HTML template: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Apply template variables to HTML content
   */
  private applyTemplate(template: string, variables: Record<string, string>): string {
    let result = template;
    
    // Replace template variables with actual values
    Object.entries(variables).forEach(([key, value]) => {
      const placeholder = `{{${key}}}`;
      result = result.replace(new RegExp(placeholder, 'g'), value);
    });

    // Log template application for debugging
    logger.debug('Template variables applied', { 
      variables: Object.keys(variables),
      contentLength: variables.content?.length || 0
    });

    return result;
  }

  /**
   * Validate that story content contains required Mythoria classes
   */
  static validateStoryContent(content: string): { isValid: boolean; missingElements: string[] } {
    const requiredClasses = [
      'mythoria-story-title',
      'mythoria-chapter',
      'mythoria-chapter-title',
      'mythoria-chapter-content'
    ];

    const missingElements: string[] = [];
    
    requiredClasses.forEach(className => {
      if (!content.includes(className)) {
        missingElements.push(className);
      }
    });

    return {
      isValid: missingElements.length === 0,
      missingElements
    };
  }

  /**
   * Generate preview HTML (for testing/debugging)
   */
  async generatePreviewHTML(
    storyContent: string,
    title: string,
    language: string = 'en'
  ): Promise<string> {
    try {
      const template = await this.loadTemplate();
      const finalHTML = this.applyTemplate(template, {
        title,
        language,
        content: storyContent
      });

      return finalHTML;
    } catch (error) {
      logger.error('Failed to generate preview HTML', {
        error: error instanceof Error ? error.message : String(error),
        title
      });
      throw error;
    }
  }
}

export default PDFService;
