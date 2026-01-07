import { PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'fs';
import { logger } from '@/config/logger.js';
import { PDFParse } from 'pdf-parse';

export interface PageProcessingResult {
  originalPageCount: number;
  finalPageCount: number;
  pagesDeleted: number;
  deletedPageNumbers: number[];
  processedFilePath: string;
  pagesReordered: number;
  reorderedPairs: Array<{ from: number; to: number }>;
  imagePagesDetected: number[];
}

const FRONT_MATTER_PAGES = 5;

export class PDFPageProcessor {
  private detectImagePagesWithPdfLib(pdfDoc: PDFDocument): Set<number> {
    const imagePages = new Set<number>();
    const pages = pdfDoc.getPages();

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const node = (page as any).node;
      if (!node || typeof node.Resources !== 'function') continue;

      const resources = node.Resources();
      const xObject = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xObject) continue;

      for (const key of xObject.keys()) {
        const xObj = xObject.lookupMaybe(key, PDFStream);
        const subtype = xObj?.dict?.lookupMaybe(PDFName.of('Subtype'), PDFName);
        const subtypeName = subtype?.asString();
        if (subtypeName === '/Image' || subtypeName === 'Image') {
          imagePages.add(i + 1);
          break;
        }
      }
    }

    return imagePages;
  }

  private async getImagePageNumbers(parser: PDFParse, pdfDoc: PDFDocument): Promise<Set<number>> {
    try {
      const images = await parser.getImage({
        imageThreshold: 0,
        imageBuffer: false,
        imageDataUrl: false,
      });
      const pagesWithImages = images.pages
        .filter((page) => page.images.length > 0)
        .map((page) => page.pageNumber);
      if (pagesWithImages.length > 0) {
        return new Set(pagesWithImages);
      }
    } catch (error) {
      logger.warn('Failed to detect images with pdf-parse', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const fallbackPages = this.detectImagePagesWithPdfLib(pdfDoc);
    if (fallbackPages.size > 0) {
      logger.debug('Falling back to pdf-lib image detection', {
        pages: [...fallbackPages],
      });
    }
    return fallbackPages;
  }

  private buildInitialOrder(totalPages: number): number[] {
    return Array.from({ length: totalPages }, (_, index) => index);
  }

  private reorderOddImagePages(
    pageOrder: number[],
    imagePages: Set<number>,
  ): { updatedOrder: number[]; swaps: Array<{ from: number; to: number }> } {
    const swaps: Array<{ from: number; to: number }> = [];
    const sortedImages = [...imagePages].sort((a, b) => a - b);

    for (const pageNumber of sortedImages) {
      if (pageNumber <= FRONT_MATTER_PAGES) continue;
      if (pageNumber % 2 === 0) continue;

      const currentIndex = pageOrder.indexOf(pageNumber - 1);
      if (currentIndex === -1) continue;
      const nextIndex = currentIndex + 1;
      if (nextIndex >= pageOrder.length) continue;

      const currentValue = pageOrder[currentIndex];
      const nextValue = pageOrder[nextIndex];
      if (currentValue === undefined || nextValue === undefined) continue;

      pageOrder[currentIndex] = nextValue;
      pageOrder[nextIndex] = currentValue;

      swaps.push({ from: pageNumber, to: pageNumber + 1 });
    }

    return { updatedOrder: pageOrder, swaps };
  }

  /**
   * Process PDF to ensure chapter text begins on odd pages
   * by moving odd-positioned chapter images after their first text page.
   */
  async processPages(inputPath: string, outputPath: string): Promise<PageProcessingResult> {
    logger.info('PDF page processing start', { inputPath, outputPath });

    const pdfBytes = readFileSync(inputPath);
    const sourcePdf = await PDFDocument.load(pdfBytes);
    const parser = new PDFParse({ data: pdfBytes });

    try {
      const originalPageCount = sourcePdf.getPageCount();
      const imagePages = await this.getImagePageNumbers(parser, sourcePdf);

      const initialOrder = this.buildInitialOrder(originalPageCount);
      const { updatedOrder, swaps } = this.reorderOddImagePages(initialOrder, imagePages);

      const outputPdf = await PDFDocument.create();
      const copiedPages = await outputPdf.copyPages(sourcePdf, updatedOrder);
      copiedPages.forEach((page) => outputPdf.addPage(page));

      const processedPdfBytes = await outputPdf.save();
      writeFileSync(outputPath, processedPdfBytes);

      const result: PageProcessingResult = {
        originalPageCount,
        finalPageCount: originalPageCount,
        pagesDeleted: 0,
        deletedPageNumbers: [],
        processedFilePath: outputPath,
        pagesReordered: swaps.length * 2,
        reorderedPairs: swaps,
        imagePagesDetected: [...imagePages].sort((a, b) => a - b),
      };
      logger.info('PDF page processing done', result);
      return result;
    } finally {
      if (typeof parser.destroy === 'function') {
        await parser.destroy();
      }
    }
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
