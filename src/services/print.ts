import { readFileSync } from 'fs';
import { join } from 'path';
import puppeteer from 'puppeteer';
import { logger } from '@/config/logger.js';
import { getTemplatesPath } from '@/shared/path-utils.js';
import { getPrintTranslations, formatPublishDate } from '@/utils/print-translations.js';
import { convertToAbsoluteImagePath } from '@/utils/imageUtils.js';

interface PaperConfig {
  paperTypes: Record<string, {
    name: string;
    caliper: number;
    description: string;
  }>;
  defaultPaperType: string;
  bleedMM: {
    interior: number;
    cover: number;
  };
  safeZoneMM: number;
  trimSize: {
    width: number;
    height: number;
  };
}

interface PrintDimensions {
  pageWidthMM: number;
  pageHeightMM: number;
  spineWidthMM: number;
  coverSpreadWMM: number;
  coverSpreadHMM: number;
}

interface RenderOptions {
  width: number;
  height: number;
  outputPath: string;
}

export class PrintService {
  private paperConfig: PaperConfig;

  constructor() {
    const configPath = join(process.cwd(), 'src', 'config', 'paper-caliper.json');
    this.paperConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
  }

  /**
   * Load a template file and replace variables
   */
  private loadTemplate(templateName: string, variables: Record<string, string>): string {
    const templatePath = join(getTemplatesPath(), templateName);
    let template = readFileSync(templatePath, 'utf-8');
    
    // Replace all {{variable}} placeholders with actual values
    for (const [key, value] of Object.entries(variables)) {
      const placeholder = `{{${key}}}`;
      template = template.replace(new RegExp(placeholder, 'g'), value);
    }
    
    return template;
  }

  /**
   * Generate table of contents HTML
   */
  private generateTableOfContents(chapters: any[]): string {
    return chapters.map((chapter: any) => {
      // Extract just the title after the colon, handling translated chapter prefixes
      let cleanTitle = chapter.title;
      
      // Look for colon and extract everything after it (trimmed)
      // If no colon is found, return the original title
      const colonIndex = cleanTitle.indexOf(':');
      if (colonIndex !== -1) {
        cleanTitle = cleanTitle.substring(colonIndex + 1).trim();
      }
      
      return `
      <div class="toc-item">
        <span class="toc-chapter-title">${cleanTitle}</span>
      </div>
    `;
    }).join('');
  }

  /**
   * Generate chapters HTML with two-page spread design
   */
  private generateChaptersHTML(chapters: any[], _storyLanguage: string): string {
    return chapters.map((chapter: any, index: number) => {      
      // Convert relative image paths to absolute URLs
      let imageUrl = '';
      if (chapter.imageUri) {
        imageUrl = convertToAbsoluteImagePath(chapter.imageUri);
      }
      
      return `
      <!-- Chapter ${index + 1} Image Page (Even/Left) -->
      <div class="chapter-image-page">
        <div class="chapter-image">
          ${imageUrl ? `<img src="${imageUrl}" alt="Chapter ${index + 1} illustration" />` : ''}
        </div>
      </div>
      
      <!-- Chapter ${index + 1} Content Page (Odd/Right) -->
      <div class="chapter-content-page">
        <div class="chapter-content-wrapper">
          <div class="chapter-title"><br/><br/>${chapter.title}</div>
          <div class="chapter-content">
            ${this.formatChapterContent(chapter.content)}
          </div>
        </div>
      </div>
    `;
    }).join('');
  }

  /**
   * Calculate print dimensions based on page count
   */
  calculateDimensions(pageCount: number, paperType?: string): PrintDimensions {
    const paperTypeKey = paperType || this.paperConfig.defaultPaperType;
    const paper = this.paperConfig.paperTypes[paperTypeKey];
    
    if (!paper) {
      throw new Error(`Unknown paper type: ${paperTypeKey}`);
    }
    
    const { trimSize, bleedMM } = this.paperConfig;
    
    const pageWidthMM = trimSize.width + (2 * bleedMM.interior);
    const pageHeightMM = trimSize.height + (2 * bleedMM.interior);
    const spineWidthMM = Math.ceil((pageCount / 2) * paper.caliper * 10) / 10; // Round up to 0.1mm
    
    const coverSpreadWMM = (2 * trimSize.width) + spineWidthMM + (2 * bleedMM.cover);
    const coverSpreadHMM = trimSize.height + (2 * bleedMM.cover);

    return {
      pageWidthMM,
      pageHeightMM,
      spineWidthMM,
      coverSpreadWMM,
      coverSpreadHMM
    };
  }

  /**
   * Render HTML to PDF using Puppeteer
   */
  async renderPDF(html: string, options: RenderOptions): Promise<void> {
    logger.info('Starting PDF rendering', { 
      width: options.width, 
      height: options.height, 
      outputPath: options.outputPath 
    });

    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-color-correct-rendering'
      ]
    });

    try {
      const page = await browser.newPage();
      
      logger.debug('Setting page content for PDF generation');
      await page.setContent(html, { waitUntil: 'networkidle0' });

      logger.debug('Generating PDF', { outputPath: options.outputPath });
      await page.pdf({
        path: options.outputPath,
        printBackground: true,
        width: `${options.width}mm`,
        height: `${options.height}mm`,
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        omitBackground: false
      });

      logger.info(`PDF generated successfully: ${options.outputPath}`);
    } catch (error) {
      logger.error('PDF generation failed', { 
        error: error instanceof Error ? error.message : String(error),
        outputPath: options.outputPath 
      });
      throw error;
    } finally {
      await browser.close();
    }
  }

  /**
   * Generate interior PDF HTML
   * 
   * Margin Strategy:
   * - Chapter images: Full bleed to page edges (0mm margin)
   * - Text content: Within 1cm (10mm) safe zone for reliable printing
   */
  generateInteriorHTML(storyData: any, dimensions: PrintDimensions): string {
    const { pageWidthMM, pageHeightMM } = dimensions;
    const { bleedMM, safeZoneMM } = this.paperConfig;
    
    // Get translations for the story language
    const storyLanguage = storyData.storyLanguage || 'en';
    const translations = getPrintTranslations(storyLanguage);

    const variables = {
      title: storyData.title || '',
      pageWidthMM: pageWidthMM.toString(),
      pageHeightMM: pageHeightMM.toString(),
      interiorBleedMM: bleedMM.interior.toString(),
      // Legacy variables (for backward compatibility with existing templates)
      safeZoneMM: safeZoneMM.toString(),
      totalMarginMM: ((bleedMM.interior + safeZoneMM) * 2).toString(),
      // New semantic variables for different content types
      imageMarginMM: '0', // Images bleed to edges - no margin
      textSafeZoneMM: safeZoneMM.toString(), // Text stays within 1cm safe zone
      textTotalMarginMM: (safeZoneMM * 2).toString(), // Total margin for text content
      dedicationMessage: storyData.dedicationMessage || '',
      customAuthor: storyData.customAuthor || 'Anonymous',
      publishDate: formatPublishDate(storyData.createdAt, storyLanguage),
      synopsis: storyData.synopsis || '',
      qrCodeImage: 'https://storage.googleapis.com/mythoria-generated-stories/qr-code.png',
      tableOfContents: this.generateTableOfContents(storyData.chapters),
      chapters: this.generateChaptersHTML(storyData.chapters, storyLanguage),
      // Translation variables
      titleLabel: translations.titleLabel,
      authorLabel: translations.authorLabel,
      publishDateLabel: translations.publishDateLabel,
      editingCompanyLabel: translations.editingCompanyLabel,
      websiteLabel: translations.websiteLabel,
      copyrightLabel: translations.copyrightLabel,
      copyrightText: translations.copyrightText,
      promotionText: translations.promotionText,
      synopsisTitle: translations.synopsisTitle,
      tocTitle: translations.tocTitle
    };

    return this.loadTemplate('interior-default.html', variables);
  }

  /**
   * Generate cover spread PDF HTML
   */
  generateCoverHTML(storyData: any, dimensions: PrintDimensions): string {
    const { coverSpreadWMM, coverSpreadHMM, spineWidthMM } = dimensions;
    const { bleedMM } = this.paperConfig;

    const variables = {
      title: storyData.title || '',
      coverSpreadWMM: coverSpreadWMM.toString(),
      coverSpreadHMM: coverSpreadHMM.toString(),
      coverBleedMM: bleedMM.cover.toString(),
      spineWidthMM: spineWidthMM.toString(),
      backcoverBackground: storyData.backcoverUri ? `url("${storyData.backcoverUri}")` : '#f5f5f5',
      frontcoverBackground: storyData.coverUri ? `url("${storyData.coverUri}")` : '#e0e0e0'
    };

    return this.loadTemplate('cover-default.html', variables);
  }

  private formatChapterContent(content: string): string {
    // Content is already formatted HTML from the database
    // Return as-is to preserve HTML formatting
    return content;
  }
}
