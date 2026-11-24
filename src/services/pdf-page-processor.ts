import { PDFDict, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'fs';
import { logger } from '@/config/logger.js';
import { PRINT_FRONT_MATTER_PAGE_COUNT } from '@/services/print-layout-constants.js';

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

function hasImageResource(resources: PDFDict | undefined, visited: Set<PDFDict>): boolean {
  if (!resources || visited.has(resources)) return false;
  visited.add(resources);

  const xObjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  if (!xObjects) return false;

  return xObjects.keys().some((key) => {
    const stream = xObjects.lookupMaybe(key, PDFStream);
    if (!stream) return false;

    const subtype = stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString();
    return (
      subtype === '/Image' ||
      (subtype === '/Form' &&
        hasImageResource(stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), visited))
    );
  });
}

/** Chrome's printed images are PDF XObjects. Inspect their resources without decoding pixels. */
export function findPrintImagePages(pdfDoc: PDFDocument): Set<number> {
  const pagesWithImages = new Set<number>();
  for (const [index, page] of pdfDoc.getPages().entries()) {
    if (hasImageResource(page.node.Resources(), new Set())) {
      pagesWithImages.add(index + 1);
    }
  }
  return pagesWithImages;
}

export class PDFPageProcessor {
  private buildInitialOrder(totalPages: number): number[] {
    return Array.from({ length: totalPages }, (_, index) => index);
  }

  private reorderOddImagePages(
    pageOrder: number[],
    imagePages: Set<number>,
  ): { updatedOrder: number[]; swaps: Array<{ from: number; to: number }> } {
    const swaps: Array<{ from: number; to: number }> = [];
    const sortedImages = [...imagePages].sort((a, b) => a - b);

    logger.debug('Starting page reordering', {
      totalPages: pageOrder.length,
      imagePagesBeforeReorder: sortedImages,
      frontMatterPages: PRINT_FRONT_MATTER_PAGE_COUNT,
    });

    for (const pageNumber of sortedImages) {
      if (pageNumber <= PRINT_FRONT_MATTER_PAGE_COUNT) {
        logger.debug('Skipping front matter image page', { pageNumber });
        continue;
      }
      if (pageNumber % 2 === 0) {
        logger.debug('Skipping even image page (already correct)', { pageNumber });
        continue;
      }

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
      logger.debug('Swapped pages', {
        imagePageNumber: pageNumber,
        swap: { from: pageNumber, to: pageNumber + 1 },
      });
    }

    logger.info('Page reordering completed', {
      totalSwaps: swaps.length,
      pagesAffected: swaps.length * 2,
      swaps,
    });

    return { updatedOrder: pageOrder, swaps };
  }

  /**
   * Process PDF to ensure chapter text begins on odd pages
   * by moving odd-positioned chapter images after their first text page.
   */
  async processPages(
    inputPath: string,
    outputPath: string,
    movedTextPageOffsetPt = 0,
  ): Promise<PageProcessingResult> {
    logger.info('PDF page processing start', { inputPath, outputPath });

    const pdfBytes = readFileSync(inputPath);
    const sourcePdf = await PDFDocument.load(pdfBytes);
    const originalPageCount = sourcePdf.getPageCount();
    logger.info('PDF loaded for processing', {
      totalPages: originalPageCount,
      filePath: inputPath,
    });

    const imagePages = findPrintImagePages(sourcePdf);

    const initialOrder = this.buildInitialOrder(originalPageCount);
    const { updatedOrder, swaps } = this.reorderOddImagePages(initialOrder, imagePages);

    // Calculate final image page positions after reordering
    const finalImagePages: number[] = [];
    for (let newPosition = 0; newPosition < updatedOrder.length; newPosition++) {
      const originalPageIndex = updatedOrder[newPosition];
      if (originalPageIndex === undefined) continue;
      const originalPageNumber = originalPageIndex + 1; // Convert to 1-based
      if (imagePages.has(originalPageNumber)) {
        finalImagePages.push(newPosition + 1); // Store as 1-based page number
      }
    }

    logger.info('Image pages mapped after reordering', {
      imagePagesBeforeReorder: [...imagePages].sort((a, b) => a - b),
      imagePagesAfterReorder: finalImagePages.sort((a, b) => a - b),
      reorderingApplied: swaps.length > 0,
    });

    const outputPdf = await PDFDocument.create();
    const copiedPages = await outputPdf.copyPages(sourcePdf, updatedOrder);
    if (movedTextPageOffsetPt !== 0) {
      for (const { from, to } of swaps) {
        // The text was laid out for a left page before being moved to a right page.
        if (!imagePages.has(to)) copiedPages[from - 1]?.translateContent(movedTextPageOffsetPt, 0);
      }
    }
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
      imagePagesDetected: finalImagePages.sort((a, b) => a - b),
    };
    logger.info('PDF page processing done', {
      ...result,
      note: 'imagePagesDetected contains FINAL positions after reordering',
    });
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
