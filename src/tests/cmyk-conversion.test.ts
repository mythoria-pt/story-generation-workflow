import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { PDFDocument, rgb } from 'pdf-lib';

const SAMPLE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';

async function createSamplePdf(filePath: string) {
  const pdfDoc = await PDFDocument.create();
  const imageBytes = Buffer.from(SAMPLE_PNG, 'base64');
  const embeddedImage = await pdfDoc.embedPng(imageBytes);

  const addTextPage = (text: string) => {
    const page = pdfDoc.addPage();
    page.drawText(text, { x: 50, y: page.getHeight() - 72, size: 18, color: rgb(0, 0, 0) });
  };

  const addImagePage = () => {
    const page = pdfDoc.addPage();
    page.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: page.getWidth(),
      height: page.getHeight(),
    });
  };

  addTextPage('Front matter page');
  addImagePage();

  const pdfBytes = await pdfDoc.save();
  writeFileSync(filePath, pdfBytes);
}

const ensureTestEnv = () => {
  process.env.NODE_ENV = 'test';
  process.env.DB_HOST = process.env.DB_HOST ?? 'localhost';
  process.env.DB_PORT = process.env.DB_PORT ?? '5432';
  process.env.DB_USER = process.env.DB_USER ?? 'user';
  process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? 'password';
  process.env.DB_NAME = process.env.DB_NAME ?? 'database';
  process.env.GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID ?? 'test-project';
  process.env.GOOGLE_CLOUD_REGION = process.env.GOOGLE_CLOUD_REGION ?? 'test-region';
  process.env.STORAGE_BUCKET_NAME = process.env.STORAGE_BUCKET_NAME ?? 'test-bucket';
};

describe('CMYKConversionService image detection', () => {
  it('identifies dominant chapter image pages while leaving text-only pages unmarked', async () => {
    ensureTestEnv();

    const workDir = mkdtempSync(path.join(tmpdir(), 'cmyk-detect-'));
    const pdfPath = path.join(workDir, 'sample.pdf');
    await createSamplePdf(pdfPath);

    const { CMYKConversionService } = await import('@/services/cmyk-conversion.js');
    const service = new CMYKConversionService();
    const imagePages = await service.detectLargeImagePages(pdfPath, {
      imageThreshold: 0,
      minPageCoverageRatio: 0.12,
      // Override default to test raw detection without page 2 exclusion
      grayscaleOnlyPages: [],
    });

    expect([...imagePages]).toEqual([2]);
  });

  it('excludes page 2 (QR code page) from color detection by default', async () => {
    ensureTestEnv();

    const workDir = mkdtempSync(path.join(tmpdir(), 'cmyk-detect-page2-'));
    const pdfPath = path.join(workDir, 'sample.pdf');
    await createSamplePdf(pdfPath);

    const { CMYKConversionService } = await import('@/services/cmyk-conversion.js');
    const service = new CMYKConversionService();
    // Use default options which should exclude page 2
    const imagePages = await service.detectLargeImagePages(pdfPath, {
      imageThreshold: 0,
      minPageCoverageRatio: 0.12,
    });

    // Page 2 should NOT be included because it's forced to grayscale by default
    expect([...imagePages]).toEqual([]);
  });
});
