import { readFileSync } from 'fs';
import { join } from 'path';
import puppeteer from 'puppeteer';
import { logger } from '@/config/logger.js';
import { getTemplatesPath } from '@/shared/path-utils.js';
import { getPrintTranslations, formatPublishDate } from '@/utils/print-translations.js';
import { convertToAbsoluteImagePath } from '@/utils/imageUtils.js';
import { CMYKConversionService } from './cmyk-conversion.js';
import { PDFPageProcessor } from './pdf-page-processor.js';

interface PaperConfig {
  paperTypes: Record<
    string,
    {
      name: string;
      caliper: number;
      description: string;
    }
  >;
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

interface PrintResult {
  interiorPdfPath: string;
  coverPdfPath: string;
  interiorPreProcessedPdfPath?: string;
  interiorPostProcessedPdfPath?: string;
  interiorCmykPdfPath?: string;
  coverCmykPdfPath?: string;
}

export class PrintService {
  private paperConfig: PaperConfig;
  private cmykService: CMYKConversionService;
  private pageProcessor: PDFPageProcessor;

  constructor() {
    const configPath =
      process.env.NODE_ENV === 'production'
        ? join(process.cwd(), 'dist', 'config', 'paper-caliper.json')
        : join(process.cwd(), 'src', 'config', 'paper-caliper.json');
    this.paperConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    this.cmykService = new CMYKConversionService();
    this.pageProcessor = new PDFPageProcessor();
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
    return chapters
      .map((chapter: any) => {
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
      })
      .join('');
  }

  /**
   * Generate chapters HTML with two-page spread design
   */
  private generateChaptersHTML(
    chapters: any[],
    _storyLanguage: string,
    targetAudience?: string,
  ): string {
    let html = '';

    // Map target audience to CSS class
    const getTargetAudienceClass = (audience?: string): string => {
      if (!audience) return '';

      const classMap: Record<string, string> = {
        'children_0-2': 'target-children-0-2',
        'children_3-6': 'target-children-3-6',
        'children_7-10': 'target-children-7-10',
        'children_11-14': 'target-children-11-14',
        'young_adult_15-17': 'target-young-adult-15-17',
        'adult_18+': 'target-adult-18-plus',
        all_ages: 'target-all-ages',
      };

      return classMap[audience] || '';
    };

    const audienceClass = getTargetAudienceClass(targetAudience);

    // Generate HTML for each chapter
    chapters.forEach((chapter: any, chapterIndex: number) => {
      // Convert relative image paths to absolute URLs
      let imageUrl = '';
      if (chapter.imageUri) {
        imageUrl = convertToAbsoluteImagePath(chapter.imageUri);
      }

      // For all chapters except the first one, add a page break before the chapter image
      // This ensures we have an empty page before each chapter image (except chapter 1)
      if (chapterIndex > 0) {
        html += `
      <!-- Page break before Chapter ${chapterIndex + 1} image -->
      <div class="page-break">
        <span style="color: #F5F5F5; font-size: 6px;">EMPTY-PAGE-MARKER</span>
      </div>
      `;
      }

      // Add chapter image (on even page)
      html += `
      <!-- Chapter ${chapterIndex + 1} Image Page (Even/Left) -->
      <div class="chapter-image-page">
        <div class="chapter-image">
          ${imageUrl ? `<img src="${imageUrl}" alt="Chapter ${chapterIndex + 1} illustration" />` : ''}
        </div>
      </div>
      `;

      // Add chapter content (starting on odd page)
      html += `
      <!-- Chapter ${chapterIndex + 1} Content Pages -->
      <div class="chapter-content-page">
        <div class="chapter-content-wrapper">
          <div class="chapter-title"><br/><br/>${chapter.title}</div>
          <div class="chapter-content ${audienceClass}">
            ${this.formatChapterContent(chapter.content)}
          </div>
        </div>
      </div>
      `;
    });

    return html;
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

    const pageWidthMM = trimSize.width + 2 * bleedMM.interior;
    const pageHeightMM = trimSize.height + 2 * bleedMM.interior;
    const spineWidthMM = Math.ceil((pageCount / 2) * paper.caliper * 10) / 10; // Round up to 0.1mm

    const coverSpreadWMM = 2 * trimSize.width + spineWidthMM + 2 * bleedMM.cover;
    const coverSpreadHMM = trimSize.height + 2 * bleedMM.cover;

    return {
      pageWidthMM,
      pageHeightMM,
      spineWidthMM,
      coverSpreadWMM,
      coverSpreadHMM,
    };
  }

  /**
   * Render HTML to PDF using Puppeteer
   */
  async renderPDF(html: string, options: RenderOptions): Promise<void> {
    logger.info('Starting PDF rendering', {
      width: options.width,
      height: options.height,
      outputPath: options.outputPath,
    });

    const launchOptions: any = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-color-correct-rendering',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-crash-reporter',
        '--disable-breakpad',
      ],
    };

    // In production, use system Chrome
    if (process.env.NODE_ENV === 'production') {
      launchOptions.executablePath = '/usr/bin/google-chrome-stable';
    }

    const browser = await puppeteer.launch(launchOptions);

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
        omitBackground: false,
      });

      logger.info(`PDF generated successfully: ${options.outputPath}`);
    } catch (error) {
      logger.error('PDF generation failed', {
        error: error instanceof Error ? error.message : String(error),
        outputPath: options.outputPath,
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
   * - Text content: Within safe zone with additional 1cm top margin
   */
  generateInteriorHTML(storyData: any, dimensions: PrintDimensions): string {
    const { pageWidthMM, pageHeightMM } = dimensions;
    const { bleedMM, safeZoneMM } = this.paperConfig;

    // Get translations for the story language
    const storyLanguage = storyData.storyLanguage || 'en';
    const translations = getPrintTranslations(storyLanguage);

    // Calculate chapter margins with additional 1cm (10mm) top margin
    const chapterTopMarginMM = safeZoneMM + 10; // Add 1cm to standard safe zone
    const chapterFirstPageTopMarginMM = 40 + 10; // Add 1cm to existing 40mm

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
      // Chapter-specific margins
      chapterTopMarginMM: chapterTopMarginMM.toString(),
      chapterFirstPageTopMarginMM: chapterFirstPageTopMarginMM.toString(),
      dedicationMessage: storyData.dedicationMessage || '',
      customAuthor: storyData.customAuthor || 'Anonymous',
      publishDate: formatPublishDate(storyData.createdAt, storyLanguage),
      synopsis: storyData.synopsis || '',
      qrCodeImage: 'https://storage.googleapis.com/mythoria-generated-stories/qr-code.png',
      tableOfContents: this.generateTableOfContents(storyData.chapters),
      chapters: this.generateChaptersHTML(
        storyData.chapters,
        storyLanguage,
        storyData.targetAudience,
      ),
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
      tocTitle: translations.tocTitle,
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
      frontcoverBackground: storyData.coverUri ? `url("${storyData.coverUri}")` : '#e0e0e0',
      graphicalStyle: storyData.graphicalStyle || 'cartoon',
    };

    return this.loadTemplate('cover-default.html', variables);
  }

  private formatChapterContent(content: string): string {
    // Content is already formatted HTML from the database
    // Return as-is to preserve HTML formatting
    return content;
  }

  /**
   * Process PDF to ensure proper page layout
   */
  async processPageLayout(inputPath: string, outputPath: string) {
    logger.info('Processing PDF page layout', {
      input: inputPath,
      output: outputPath,
    });

    const result = await this.pageProcessor.processPages(inputPath, outputPath);

    logger.info('PDF page processing completed', {
      originalPages: result.originalPageCount,
      finalPages: result.finalPageCount,
      pagesDeleted: result.pagesDeleted,
      deletedPageNumbers: result.deletedPageNumbers,
    });

    return result;
  }

  /**
   * Convert RGB PDFs to CMYK/PDF-X format
   */
  async convertToCMYK(
    interiorPdfPath: string,
    coverPdfPath: string,
    storyData: any,
  ): Promise<{ interiorCmykPath: string; coverCmykPath: string }> {
    logger.info('Starting CMYK conversion for print files', {
      interior: interiorPdfPath,
      cover: coverPdfPath,
      storyId: storyData.id,
    });

    try {
      const metadata = {
        title: storyData.title || 'Mythoria Story',
        author: storyData.customAuthor || 'Mythoria',
        subject: 'Print-ready story book',
        creator: 'Mythoria Print Service',
      };

      const result = await this.cmykService.convertPrintSetToCMYK(
        interiorPdfPath,
        coverPdfPath,
        metadata,
      );

      logger.info('CMYK conversion completed successfully', {
        interiorCmyk: result.interiorCMYK,
        coverCmyk: result.coverCMYK,
        storyId: storyData.id,
      });

      return {
        interiorCmykPath: result.interiorCMYK,
        coverCmykPath: result.coverCMYK,
      };
    } catch (error) {
      logger.error('CMYK conversion failed', {
        error: error instanceof Error ? error.message : String(error),
        storyId: storyData.id,
      });
      throw error;
    }
  }

  /**
   * Generate complete print set with both RGB and CMYK versions
   */
  async generatePrintSet(
    storyData: any,
    interiorOutputPath: string,
    coverOutputPath: string,
    options: { generateCMYK?: boolean } = {},
  ): Promise<PrintResult> {
    const pageCount = storyData.chapters?.length * 4 + 8; // Rough estimate
    const dimensions = this.calculateDimensions(pageCount);

    // Generate RGB PDFs first
    const interiorHTML = this.generateInteriorHTML(storyData, dimensions);
    const coverHTML = this.generateCoverHTML(storyData, dimensions);

    // Create paths for different PDF versions
    const interiorPreProcessedPath = interiorOutputPath.replace('.pdf', '_pre-page-processing.pdf');
    const interiorPostProcessedPath = interiorOutputPath.replace(
      '.pdf',
      '_post-page-processing.pdf',
    );

    // Render initial RGB PDFs
    await Promise.all([
      this.renderPDF(interiorHTML, {
        width: dimensions.pageWidthMM,
        height: dimensions.pageHeightMM,
        outputPath: interiorPreProcessedPath, // Save as pre-processed version first
      }),
      this.renderPDF(coverHTML, {
        width: dimensions.coverSpreadWMM,
        height: dimensions.coverSpreadHMM,
        outputPath: coverOutputPath,
      }),
    ]);

    // Process the interior PDF to fix page layout
    await this.processPageLayout(interiorPreProcessedPath, interiorPostProcessedPath);

    const result: PrintResult = {
      interiorPdfPath: interiorPostProcessedPath, // Use post-processed version as main
      coverPdfPath: coverOutputPath,
      interiorPreProcessedPdfPath: interiorPreProcessedPath,
      interiorPostProcessedPdfPath: interiorPostProcessedPath,
    };

    // Generate CMYK versions if requested (using post-processed PDF)
    if (options.generateCMYK !== false) {
      try {
        const cmykResult = await this.convertToCMYK(
          interiorPostProcessedPath, // Use post-processed version for CMYK
          coverOutputPath,
          storyData,
        );

        result.interiorCmykPdfPath = cmykResult.interiorCmykPath;
        result.coverCmykPdfPath = cmykResult.coverCmykPath;
      } catch (error) {
        logger.warn('CMYK conversion failed, continuing with RGB only', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return result;
  }
}
