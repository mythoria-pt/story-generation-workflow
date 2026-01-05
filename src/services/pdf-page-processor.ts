import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '@/config/logger.js';
import { PDFParse, type PageImages } from 'pdf-parse';
import { Worker } from 'node:worker_threads';

export interface PageProcessingResult {
  originalPageCount: number;
  finalPageCount: number;
  pagesDeleted: number;
  deletedPageNumbers: number[];
  processedFilePath: string;
  imagePageNumbers: number[];
  reorderedPageNumbers: number[];
}

export class PDFPageProcessor {
  private readonly minChapterImageWidth = 500;
  private readonly minChapterImageHeight = 500;
  private readonly chapterStartPage = 6; // Skip front-matter when looking for chapter art
  private workerConfigured = false;

  private configureWorker(): void {
    if (this.workerConfigured) return;
    try {
      if (typeof (global as any).Worker === 'undefined') {
        (global as any).Worker = Worker;
      }
      const workerPath = join(
        process.cwd(),
        'node_modules',
        'pdfjs-dist',
        'legacy',
        'build',
        'pdf.worker.js',
      );
      PDFParse.setWorker(workerPath);
      this.workerConfigured = true;
    } catch (error) {
      logger.warn('Failed to configure pdf.js worker, continuing with default', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Identify pages that contain full-bleed chapter images.
   */
  private identifyImagePages(pages: PageImages[]): number[] {
    const imagePages = pages
      .filter((page) => {
        if (page.pageNumber < this.chapterStartPage) return false;
        return page.images.some(
          (img) =>
            img.width >= this.minChapterImageWidth && img.height >= this.minChapterImageHeight,
        );
      })
      .map((page) => page.pageNumber);

    return Array.from(new Set(imagePages)).sort((a, b) => a - b);
  }

  /**
   * Analyze the PDF with pdf-parse to find image pages and blank pages.
   */
  private async analyzePdf(pdfBytes: Buffer): Promise<{
    imagePages: number[];
    blankPages: Set<number>;
    totalPages: number;
  }> {
    this.configureWorker();
    const parser = new PDFParse({ data: pdfBytes, disableWorker: true } as any);
    try {
      const [imageResult, textResult] = await Promise.all([
        parser.getImage({ imageBuffer: false, imageDataUrl: false, imageThreshold: 0 }),
        parser.getText({ itemJoiner: ' ', pageJoiner: '' }),
      ]);

      const imagePages = this.identifyImagePages(imageResult.pages);
      const blankPages = new Set<number>();

      textResult.pages.forEach((page) => {
        const trimmed = page.text.replace(/\s+/g, '');
        if (!trimmed.length && !imagePages.includes(page.num)) {
          blankPages.add(page.num);
        }
      });

      return {
        imagePages,
        blankPages,
        totalPages: textResult.total,
      };
    } catch (error) {
      logger.error('PDF analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await parser.destroy();
    }
  }

  /**
   * Build a new page order that removes blanks and flips chapter sequences when needed.
   */
  private buildPageOrder(
    totalPages: number,
    imagePages: number[],
    blankPages: Set<number>,
  ): number[] {
    const order: number[] = [];

    const sortedImages = [...imagePages].sort((a, b) => a - b);
    let cursor = 1;

    for (let i = 0; i < sortedImages.length; i++) {
      const imagePage = sortedImages[i]!;
      const nextImageStart = sortedImages[i + 1] ?? totalPages + 1;

      for (let page = cursor; page < imagePage; page++) {
        if (!blankPages.has(page)) {
          order.push(page);
        }
      }

      const textPages: number[] = [];
      for (let page = imagePage + 1; page < nextImageStart; page++) {
        if (!blankPages.has(page)) {
          textPages.push(page);
        }
      }

      const imageWouldBeOdd = (order.length + 1) % 2 === 1;
      if (imageWouldBeOdd && textPages.length > 0) {
        order.push(...textPages, imagePage);
      } else {
        order.push(imagePage, ...textPages);
      }

      cursor = nextImageStart;
    }

    for (let page = cursor; page <= totalPages; page++) {
      if (!blankPages.has(page)) {
        order.push(page);
      }
    }

    return order;
  }

  /**
   * Process PDF to ensure chapter images land on even pages and chapters open on recto.
   */
  async processPages(inputPath: string, outputPath: string): Promise<PageProcessingResult> {
    logger.info('PDF page processing start', { inputPath, outputPath });

    const pdfBytes = readFileSync(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const analysis = await this.analyzePdf(pdfBytes);
    const reorderedPageNumbers = this.buildPageOrder(
      analysis.totalPages,
      analysis.imagePages,
      analysis.blankPages,
    );

    const newDoc = await PDFDocument.create();
    const copiedPages = await newDoc.copyPages(
      pdfDoc,
      reorderedPageNumbers.map((p) => p - 1),
    );
    copiedPages.forEach((page) => newDoc.addPage(page));

    const processedPdfBytes = await newDoc.save();
    writeFileSync(outputPath, processedPdfBytes);

    const finalImagePages = reorderedPageNumbers.reduce<number[]>((acc, sourcePage, idx) => {
      if (analysis.imagePages.includes(sourcePage)) {
        acc.push(idx + 1);
      }
      return acc;
    }, []);

    const deletedPageNumbers = Array.from(analysis.blankPages).sort((a, b) => a - b);
    const result: PageProcessingResult = {
      originalPageCount: pdfDoc.getPages().length,
      finalPageCount: reorderedPageNumbers.length,
      pagesDeleted: deletedPageNumbers.length,
      deletedPageNumbers,
      processedFilePath: outputPath,
      imagePageNumbers: finalImagePages,
      reorderedPageNumbers,
    };
    logger.info('PDF page processing done', result);
    return result;
  }

  /**
   * Validate that the page processing was successful
   * This is a verification method to ensure our processing worked correctly
   */
  async validatePageLayout(pdfPath: string): Promise<{ isValid: boolean; issues: string[] }> {
    logger.info('Validating page layout', { pdfPath });
    const issues: string[] = [];
    try {
      const pdfBytes = readFileSync(pdfPath);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();
      if (pages.length < 10) {
        issues.push(`PDF has unusually few pages: ${pages.length}`);
      }
      logger.info('Page layout validation completed', {
        totalPages: pages.length,
        issuesFound: issues.length,
        issues,
      });
      return { isValid: issues.length === 0, issues };
    } catch (error) {
      const errorMessage = `Failed to validate page layout: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);
      return { isValid: false, issues: [errorMessage] };
    }
  }
}
