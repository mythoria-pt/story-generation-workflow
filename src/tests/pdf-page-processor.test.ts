import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const SMALL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YlTHssAAAAASUVORK5CYII=';

let mockImagePages: Array<{ pageNumber: number; images: any[] }> = [];
let mockTextPages: Array<{ num: number; text: string }> = [];
let mockTotalPages = 0;

jest.mock('pdf-parse', () => {
  return {
    PDFParse: class {
      static setWorker() {}
      constructor() {}
      async getImage() {
        return { pages: mockImagePages, total: mockTotalPages };
      }
      async getText() {
        return {
          pages: mockTextPages,
          text: mockTextPages.map((p) => p.text).join('\n'),
          total: mockTotalPages,
          getPageText: (num: number) => mockTextPages.find((p) => p.num === num)?.text ?? '',
        };
      }
      async destroy() {}
    },
  };
});

function seedParserMocks(
  totalPages: number,
  imagePageNumbers: number[],
  textByPage: Record<number, string>,
) {
  mockTotalPages = totalPages;
  mockImagePages = imagePageNumbers.map((pageNumber) => ({
    pageNumber,
    images: [
      {
        data: new Uint8Array(),
        dataUrl: '',
        name: `image-${pageNumber}`,
        width: 600,
        height: 600,
        kind: 3,
      },
    ],
  }));
  mockTextPages = Array.from({ length: totalPages }, (_, idx) => {
    const pageNumber = idx + 1;
    return {
      num: pageNumber,
      text: textByPage[pageNumber] ?? '',
    };
  });
}

async function createTestPdf(
  frontMatterPages: number,
  chapterText: string,
  includeTrailingBlank: boolean,
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const embeddedPng = await pdfDoc.embedPng(Buffer.from(SMALL_PNG_BASE64, 'base64'));

  for (let i = 1; i <= frontMatterPages; i++) {
    const page = pdfDoc.addPage();
    page.drawText(`Front page ${i}`, {
      x: 50,
      y: page.getHeight() - 50,
      size: 18,
      font,
    });
  }

  const imagePage = pdfDoc.addPage();
  imagePage.drawImage(embeddedPng, {
    x: 0,
    y: 0,
    width: imagePage.getWidth(),
    height: imagePage.getHeight(),
  });

  const textPage = pdfDoc.addPage();
  textPage.drawText(chapterText, {
    x: 50,
    y: textPage.getHeight() - 50,
    size: 18,
    font,
  });

  if (includeTrailingBlank) {
    pdfDoc.addPage();
  }

  return pdfDoc.save();
}

describe('PDFPageProcessor', () => {
  let PDFPageProcessorCtor: typeof import('@/services/pdf-page-processor.js').PDFPageProcessor;

  beforeAll(async () => {
    process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? 'test';
    process.env.GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID ?? 'test-project';
    process.env.GOOGLE_CLOUD_REGION = process.env.GOOGLE_CLOUD_REGION ?? 'test-region';
    process.env.STORAGE_BUCKET_NAME = process.env.STORAGE_BUCKET_NAME ?? 'bucket';
    ({ PDFPageProcessor: PDFPageProcessorCtor } = await import('@/services/pdf-page-processor.js'));
  });

  it('reorders odd image pages after text and removes blanks', async () => {
    const pdfBuffer = await createTestPdf(6, 'Chapter 1 text page', true);
    const tempDir = mkdtempSync(join(tmpdir(), 'pdf-processor-'));
    const inputPath = join(tempDir, 'input.pdf');
    const outputPath = join(tempDir, 'output.pdf');
    writeFileSync(inputPath, pdfBuffer);

    const processor = new PDFPageProcessorCtor() as any;
    processor.minChapterImageWidth = 1;
    processor.minChapterImageHeight = 1;

    const totalPages = 9;
    seedParserMocks(totalPages, [7], {
      1: 'Front page 1',
      2: 'Front page 2',
      3: 'Front page 3',
      4: 'Front page 4',
      5: 'Front page 5',
      6: 'Front page 6',
      7: '',
      8: 'Chapter 1 text page',
      9: '',
    });

    const result = await processor.processPages(inputPath, outputPath);
    const processedDoc = await PDFDocument.load(readFileSync(outputPath));

    expect(result.pagesDeleted).toBe(1);
    expect(result.deletedPageNumbers).toEqual([9]);
    expect(result.reorderedPageNumbers).toEqual([1, 2, 3, 4, 5, 6, 8, 7]);
    expect(result.imagePageNumbers).toEqual([8]);
    expect(processedDoc.getPageCount()).toBe(result.finalPageCount);
  });

  it('keeps even image pages before text', async () => {
    const pdfBuffer = await createTestPdf(5, 'Chapter 2 text page', false);
    const tempDir = mkdtempSync(join(tmpdir(), 'pdf-processor-'));
    const inputPath = join(tempDir, 'input.pdf');
    const outputPath = join(tempDir, 'output.pdf');
    writeFileSync(inputPath, pdfBuffer);

    const processor = new PDFPageProcessorCtor() as any;
    processor.minChapterImageWidth = 1;
    processor.minChapterImageHeight = 1;

    const totalPages = 7;
    seedParserMocks(totalPages, [6], {
      1: 'Front page 1',
      2: 'Front page 2',
      3: 'Front page 3',
      4: 'Front page 4',
      5: 'Front page 5',
      6: '',
      7: 'Chapter 2 text page',
    });

    const result = await processor.processPages(inputPath, outputPath);
    const processedDoc = await PDFDocument.load(readFileSync(outputPath));

    expect(result.pagesDeleted).toBe(0);
    expect(result.reorderedPageNumbers).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.imagePageNumbers).toEqual([6]);
    expect(processedDoc.getPageCount()).toBe(result.finalPageCount);
  });
});
