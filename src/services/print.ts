import { readFileSync } from 'fs';
import { join } from 'path';
import puppeteer from 'puppeteer';
import { logger } from '@/config/logger.js';
import { StorageService } from './storage.js';

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
  private storageService: StorageService;

  constructor() {
    const configPath = join(process.cwd(), 'config', 'paper-caliper.json');
    this.paperConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    this.storageService = new StorageService();
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
        displayHeaderFooter: false
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
   */
  async generateInteriorHTML(storyData: any, dimensions: PrintDimensions): Promise<string> {
    const { pageWidthMM, pageHeightMM } = dimensions;
    const { bleedMM, safeZoneMM } = this.paperConfig;

    // Resolve all chapter image URIs to absolute URLs
    const chaptersWithResolvedImages = await Promise.all(
      storyData.chapters.map(async (chapter: any) => ({
        ...chapter,
        imageUri: await this.resolveImageUri(chapter.imageUri)
      }))
    );

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${storyData.title}</title>
  <style>
    @page {
      size: ${pageWidthMM}mm ${pageHeightMM}mm;
      margin: 0;
      bleed: ${bleedMM.interior}mm;
      marks: crop cross;
    }

    body {
      margin: ${bleedMM.interior}mm;
      padding: ${safeZoneMM}mm;
      font-family: 'Times New Roman', 'Liberation Serif', serif;
      font-size: 11pt;
      line-height: 1.5;
      text-align: justify;
      font-display: block;
    }

    .page {
      page-break-after: always;
      min-height: calc(100vh - ${(bleedMM.interior + safeZoneMM) * 2}mm);
      display: flex;
      flex-direction: column;
    }

    .page:last-child {
      page-break-after: avoid;
    }

    .title-page {
      justify-content: center;
      align-items: center;
      text-align: center;
    }

    .title-page h1 {
      font-size: 24pt;
      font-weight: bold;
      margin: 0;
    }

    .dedication-page {
      justify-content: space-between;
      text-align: center;
    }

    .dedication-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }

    .dedication-author {
      text-align: right;
      font-style: italic;
      margin-top: 20px;
    }

    .mythoria-credit {
      text-align: center;
      font-size: 9pt;
      color: #666;
    }

    .toc {
      padding: 20px 0;
    }

    .toc h2 {
      text-align: center;
      font-size: 18pt;
      margin-bottom: 30px;
    }

    .toc-item {
      margin-bottom: 8px;
      text-align: left;
    }

    .chapter {
      break-before: right !important;
      margin-top: 0;
    }

    .chapter-title {
      text-align: center;
      font-size: 16pt;
      font-weight: bold;
      margin-bottom: 30px;
    }

    .chapter-image {
      text-align: center;
      margin: 20px 0 30px 0;
      width: 100%;
    }

    .chapter-image img {
      width: 100%;
      height: auto;
      image-rendering: pixelated;
      display: block;
      margin: 0 auto;
    }

    .chapter-content p {
      text-indent: 1em;
      margin-bottom: 0.5em;
    }
  </style>
</head>
<body>
  <!-- Page 1: Title -->
  <div class="page title-page">
    <h1>${storyData.title}</h1>
  </div>

  <!-- Page 2: Empty -->
  <div class="page"></div>

  <!-- Page 3: Dedication -->
  <div class="page dedication-page">
    <div class="dedication-content">
      <div>${storyData.dedicationMessage || ''}</div>
      <div class="dedication-author">- ${storyData.customAuthor || 'Anonymous'}</div>
    </div>
    <div class="mythoria-credit">
      <p>Story imagined by: ${storyData.customAuthor || 'Anonymous'}.</p>
      <p>This story was created by:</p>
      <p><strong>Mythoria</strong></p>
      <p>Create your own story at mythoria.pt</p>
    </div>
  </div>

  <!-- Page 4: Empty -->
  <div class="page"></div>

  <!-- Page 5: Table of Contents -->
  <div class="page">
    <div class="toc">
      <h2>Table of Contents</h2>
      ${chaptersWithResolvedImages.map((chapter: any, index: number) => `
        <div class="toc-item">
          ${index + 1}. ${chapter.title}
        </div>
      `).join('')}
    </div>
  </div>

  <!-- Chapters -->
  ${chaptersWithResolvedImages.map((chapter: any, index: number) => `
    <div class="chapter page">
      <div class="chapter-title">
        ${index + 1}. ${chapter.title}
      </div>
      ${chapter.imageUri ? `
        <div class="chapter-image">
          <img src="${chapter.imageUri}" alt="Chapter ${index + 1} illustration" />
        </div>
      ` : ''}
      <div class="chapter-content">
        ${this.formatChapterContent(chapter.content)}
      </div>
    </div>
  `).join('')}

  <!-- Final empty page to end on recto -->
  <div class="page"></div>
</body>
</html>`;
  }

  /**
   * Generate cover spread PDF HTML
   */
  async generateCoverHTML(storyData: any, dimensions: PrintDimensions): Promise<string> {
    const { coverSpreadWMM, coverSpreadHMM, spineWidthMM } = dimensions;
    const { bleedMM } = this.paperConfig;

    // Resolve cover and backcover image URIs to absolute URLs
    const resolvedCoverUri = await this.resolveImageUri(storyData.coverUri);
    const resolvedBackcoverUri = await this.resolveImageUri(storyData.backcoverUri);

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${storyData.title} - Cover</title>
  <style>
    @page {
      size: ${coverSpreadWMM}mm ${coverSpreadHMM}mm;
      margin: 0;
      bleed: ${bleedMM.cover}mm;
    }

    body {
      margin: 0;
      padding: 0;
      font-family: 'Times New Roman', 'Liberation Serif', serif;
      width: 100%;
      height: 100vh;
      display: flex;
    }

    .cover {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
    }

    .back-cover {
      width: calc((100% - ${spineWidthMM}mm) / 2);
      height: 100%;
      background: ${resolvedBackcoverUri ? `url("${resolvedBackcoverUri}")` : '#f5f5f5'};
      background-size: cover;
      background-position: center;
    }

    .spine {
      width: ${spineWidthMM}mm;
      height: 100%;
      background: #333;
      display: flex;
      align-items: center;
      justify-content: center;
      writing-mode: vertical-lr;
      text-orientation: mixed;
      color: white;
      font-size: 12pt;
      font-weight: bold;
    }

    .front-cover {
      width: calc((100% - ${spineWidthMM}mm) / 2);
      height: 100%;
      background: ${resolvedCoverUri ? `url("${resolvedCoverUri}")` : '#e0e0e0'};
      background-size: cover;
      background-position: center;
    }
  </style>
</head>
<body>
  <div class="cover">
    <div class="back-cover"></div>
    <div class="spine">${storyData.title}</div>
    <div class="front-cover"></div>
  </div>
</body>
</html>`;
  }

  private formatChapterContent(content: string): string {
    // Check if content is already HTML formatted (contains HTML tags)
    const hasHtmlTags = /<[^>]+>/.test(content);
    
    if (hasHtmlTags) {
      // Content is already HTML formatted, return as-is
      return content;
    }
    
    // Content is plain text, format it with paragraph tags
    // All paragraphs should be indented (no special case for first paragraph)
    return content
      .split('\n\n')
      .filter(p => p.trim())
      .map(p => `<p>${p.trim()}</p>`)
      .join('');
  }

  /**
   * Resolve image URI to absolute URL if it's relative
   */
  private async resolveImageUri(imageUri: string | null | undefined): Promise<string | null> {
    if (!imageUri) {
      return null;
    }

    // Check if URI is already absolute (starts with http:// or https://)
    if (imageUri.startsWith('http://') || imageUri.startsWith('https://')) {
      return imageUri;
    }

    // URI is relative, convert to absolute using StorageService
    try {
      const absoluteUrl = await this.storageService.getPublicUrl(imageUri);
      logger.debug('Converted relative image URI to absolute', { 
        relative: imageUri, 
        absolute: absoluteUrl 
      });
      return absoluteUrl;
    } catch (error) {
      logger.warn('Failed to convert relative image URI to absolute, using original', { 
        imageUri, 
        error: error instanceof Error ? error.message : String(error) 
      });
      return imageUri; // Fall back to original relative URL
    }
  }
}
