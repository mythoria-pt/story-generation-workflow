import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { PDFDict, PDFDocument, PDFName, PDFStream, rgb } from 'pdf-lib';

const SAMPLE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';

async function createSamplePdf(filePath: string) {
  const pdfDoc = await PDFDocument.create();
  const pngBytes = Buffer.from(SAMPLE_PNG, 'base64');
  const image = await pdfDoc.embedPng(pngBytes);

  const addTextPage = (text: string) => {
    const page = pdfDoc.addPage();
    page.drawText(text, { x: 50, y: page.getHeight() - 72, size: 18, color: rgb(0, 0, 0) });
  };

  const addImagePage = (label: string) => {
    const page = pdfDoc.addPage();
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: page.getWidth(),
      height: page.getHeight(),
    });
    page.drawText(label, { x: 50, y: page.getHeight() - 72, size: 14, color: rgb(0, 0, 0) });
  };

  // Front matter (5 pages)
  for (let i = 1; i <= 5; i++) {
    addTextPage(`Front matter page ${i}`);
  }

  // Chapter 1: image on even page (should stay in place)
  addImagePage('Chapter 1 image');
  addTextPage('Chapter 1 - Page 1');
  addTextPage('Chapter 1 - Page 2');

  // Chapter 2: image intentionally lands on an odd page (should be reordered)
  addImagePage('Chapter 2 image');
  addTextPage('Chapter 2 - Page 1');
  addTextPage('Chapter 2 - Page 2');

  const pdfBytes = await pdfDoc.save();
  writeFileSync(filePath, pdfBytes);
}

describe('PDFPageProcessor', () => {
  it('reorders odd-positioned chapter images so text starts on odd pages', async () => {
    process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? 'test';
    process.env.GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID ?? 'test-project';
    process.env.GOOGLE_CLOUD_REGION = process.env.GOOGLE_CLOUD_REGION ?? 'test-region';
    process.env.STORAGE_BUCKET_NAME = process.env.STORAGE_BUCKET_NAME ?? 'test-bucket';

    const { PDFPageProcessor } = await import('@/services/pdf-page-processor.js');
    const workDir = mkdtempSync(path.join(tmpdir(), 'pdf-processor-'));
    const inputPath = path.join(workDir, 'input.pdf');
    const outputPath = path.join(workDir, 'output.pdf');

    await createSamplePdf(inputPath);

    const processor = new PDFPageProcessor();
    const result = await processor.processPages(inputPath, outputPath);

    expect(result.reorderedPairs).toEqual([{ from: 9, to: 10 }]);

    const outputPdf = await PDFDocument.load(readFileSync(outputPath));
    const pages = outputPdf.getPages();

    const imagePages = pages.reduce<number[]>((acc, page, index) => {
      const resources = page.node.Resources?.();
      if (!resources) return acc;

      const xObject = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xObject) return acc;

      const hasImage = xObject.keys().some((key) => {
        const stream = xObject.lookupMaybe(key, PDFStream);
        const subtype = stream?.dict?.lookupMaybe(PDFName.of('Subtype'), PDFName);
        const subtypeName = subtype?.asString();
        return subtypeName === '/Image' || subtypeName === 'Image';
      });

      if (hasImage) acc.push(index + 1);
      return acc;
    }, []);

    expect(imagePages).toEqual([6, 10]);
  });
});
