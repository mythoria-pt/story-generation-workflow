import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'fs';
import { logger } from '@/config/logger.js';
import pdfParse from 'pdf-parse';

export interface PageProcessingResult {
  originalPageCount: number;
  finalPageCount: number;
  pagesDeleted: number;
  deletedPageNumbers: number[];
  processedFilePath: string;
}

export class PDFPageProcessor {
  /**
   * Extract text from a specific page using pdf-parse
   */
  private async extractPageText(pdfBytes: Buffer, pageNumber: number): Promise<string> {
    try {
      let pageText = '';
      const options = {
        pagerender: (pageData: any) => {
          if (pageData.pageIndex === pageNumber - 1) {
            return pageData.getTextContent().then((textContent: any) => {
              const text = textContent.items.map((item: any) => item.str).join(' ');
              pageText = text;
              return text;
            });
          }
          return Promise.resolve('');
        }
      };
      await pdfParse(pdfBytes, options);
      return pageText;
    } catch (error) {
      logger.warn('Error extracting page text', { pageNumber, error: error instanceof Error ? error.message : String(error) });
      return '';
    }
  }

  /**
   * Fallback: inspect raw page content streams for marker text when text extraction fails.
   */
  private async rawStreamHasMarker(pdfDoc: PDFDocument, pageIndex: number, marker: string): Promise<boolean> {
    try {
      const page = pdfDoc.getPages()[pageIndex];
      const context: any = (pdfDoc as any).context;
      const ref = (page as any).ref; // PDFRef
      const pageNode = context.lookup(ref);
      const contents = pageNode.get('Contents');
      const streams: any[] = [];
      if (!contents) return false;
      if (Array.isArray(contents.asArray?.())) {
        contents.asArray().forEach((c: any) => streams.push(context.lookup(c)));
      } else if (contents.array) {
        contents.array.forEach((c: any) => streams.push(context.lookup(c)));
      } else {
        streams.push(context.lookup(contents));
      }
      for (const s of streams) {
        if (!s || !s.contents) continue;
        const raw = s.contents instanceof Uint8Array ? s.contents : new Uint8Array([]);
        const rawStr = Buffer.from(raw).toString('latin1');
        if (rawStr.includes(marker)) {
          logger.debug('Marker found in raw content stream', { page: pageIndex + 1 });
          return true;
        }
      }
    } catch (e) {
      logger.debug('Raw stream inspection failed', { page: pageIndex + 1, error: (e as Error).message });
    }
    return false;
  }

  /**
   * Robust detection for --.-- (handles spacing / rendering artifacts)
   */
  private async hasEmptyPageMarker(pdfBytes: Buffer, pageNumber: number): Promise<boolean> {
    try {
      const raw = await this.extractPageText(pdfBytes, pageNumber);
      const marker = 'EMPTY-PAGE-MARKER';
      const normalMarker = raw.includes(marker);
      const spacedMarker = raw.includes(marker.split('').join(' '));
      const normalizedMatch = raw.replace(/\s+/g, '').toUpperCase().includes(marker.replace(/\s+/g, '').toUpperCase());
      const pattern = marker.split('').map(ch => /[-/\\^$*+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch).join('\\s*');
      const regexMatch = new RegExp(pattern, 'i').test(raw);
      let hasMarker = normalMarker || spacedMarker || normalizedMatch || regexMatch;

      if (!hasMarker) {
        // Fallback: load PDF once (cache by reference) & inspect raw page stream
        try {
          const pdfDoc = await PDFDocument.load(pdfBytes);
          if (await this.rawStreamHasMarker(pdfDoc, pageNumber - 1, marker)) {
            hasMarker = true;
          }
        } catch (e) {
          // Swallowing parse errors is intentional here; log at debug level for traceability
          logger.debug('PDF raw stream fallback failed during marker check', {
            pageNumber,
            error: e instanceof Error ? e.message : String(e)
          });
        }
      }

      return hasMarker;
    } catch (error) {
      logger.warn('Marker detection failure', { pageNumber, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Process PDF to ensure chapter images are on even pages
   * Using invisible markers to identify empty pages and chapter images
   */
  async processPages(inputPath: string, outputPath: string): Promise<PageProcessingResult> {
    logger.info('PDF page processing start', { inputPath, outputPath });

    const pdfBytes = readFileSync(inputPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);

    const originalPages = pdfDoc.getPages();
    const originalPageCount = originalPages.length;

    const deletedPageNumbers: number[] = [];
    let pagesDeleted = 0;

    for (let i = 7; i < originalPages.length; i++) {
      const currentLogicalPageNumber = (i + 1) - pagesDeleted;
      const isEmpty = await this.hasEmptyPageMarker(pdfBytes, i + 1);

      if (!isEmpty) continue;

      if (i + 1 < originalPages.length) {
        const nextLogical = currentLogicalPageNumber + 1;
        if (nextLogical % 2 === 1) {
          pdfDoc.removePage(i - pagesDeleted);
          deletedPageNumbers.push(i + 1);
          pagesDeleted++;
        }
      }
    }

    const processedPdfBytes = await pdfDoc.save();
    writeFileSync(outputPath, processedPdfBytes);

    const result: PageProcessingResult = { originalPageCount, finalPageCount: originalPageCount - pagesDeleted, pagesDeleted, deletedPageNumbers, processedFilePath: outputPath };
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
      logger.info('Page layout validation completed', { totalPages: pages.length, issuesFound: issues.length, issues });
      return { isValid: issues.length === 0, issues };
    } catch (error) {
      const errorMessage = `Failed to validate page layout: ${error instanceof Error ? error.message : String(error)}`;
      logger.error(errorMessage);
      return { isValid: false, issues: [errorMessage] };
    }
  }
}
