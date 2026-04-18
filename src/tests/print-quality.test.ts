import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrintQualityService, buildAutoFixBaselineSignature } from '@/services/print-quality.js';
import { StoryService } from '@/services/story.js';
import type { PrintQaAssetUrls } from '@/types/print-quality.js';

const tsxCliPath = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

const buildSparseIssue = (chapterNumber: number, pageNumber: number) => ({
  code: 'chapter_sparse_last_page',
  severity: 'critical' as const,
  chapterNumber,
  pageNumbers: [pageNumber],
  message: `Chapter ${chapterNumber} ends on an almost empty page.`,
});

const buildDeterministicAnalysis = (sparseChapterNumbers: number[]) => ({
  totalInteriorPages: 28,
  pageTexts: [],
  imagePages: new Set<number>(),
  chapterRanges: sparseChapterNumbers.map((chapterNumber, index) => ({
    chapterNumber,
    title: `Chapter ${chapterNumber}`,
    startPage: 7 + index * 4,
    endPage: chapterNumber === 1 ? 10 : chapterNumber === 3 ? 20 : 25,
  })),
  passes: [],
  warnings: [],
  criticalErrors: sparseChapterNumbers.map((chapterNumber) =>
    buildSparseIssue(chapterNumber, chapterNumber === 1 ? 10 : chapterNumber === 3 ? 20 : 25),
  ),
});

const inferProfileLevel = (layoutOverride?: {
  marginLeftMM?: number;
  marginRightMM?: number;
  lineHeightPt?: number;
  paragraphSpacingPt?: number;
}): number => {
  if (!layoutOverride) {
    return 0;
  }

  switch (layoutOverride.marginLeftMM) {
    case 20.25:
      return 1;
    case 19.5:
      return 2;
    case 18.75:
      return 3;
    case 18:
      return 4;
    case 17.25:
      return 5;
    default:
      return 0;
  }
};

describe('PrintQualityService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('extracts PDF text and images without concurrent parser transfer errors', async () => {
    const stdout = execFileSync(process.execPath, [tsxCliPath, '-'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
      },
      input: `
          import { PDFDocument, StandardFonts } from 'pdf-lib';
          import printQualityModule from './src/services/print-quality.ts';
          const { PrintQualityService } = printQualityModule;

          const pngBase64 =
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0XQAAAAASUVORK5CYII=';
          const pdfDoc = await PDFDocument.create();
          const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
          const textPage = pdfDoc.addPage([400, 400]);
          textPage.drawText('Chapter 1: Hello world', { x: 50, y: 300, size: 24, font });
          const embeddedPng = await pdfDoc.embedPng(Buffer.from(pngBase64, 'base64'));
          const imagePage = pdfDoc.addPage([400, 400]);
          imagePage.drawImage(embeddedPng, { x: 50, y: 150, width: 200, height: 200 });

          const service = Object.create(PrintQualityService.prototype);
          const artifacts = await service.getPdfArtifacts(Buffer.from(await pdfDoc.save()));
          console.log(JSON.stringify({
            totalPages: artifacts.totalPages,
            firstPageText: artifacts.pageTexts[0]?.text ?? '',
            imagePages: [...artifacts.imagePages],
          }));
        `,
    });

    const artifacts = JSON.parse(stdout.trim()) as {
      totalPages: number;
      firstPageText: string;
      imagePages: number[];
    };

    expect(artifacts.totalPages).toBe(2);
    expect(artifacts.firstPageText).toContain('Chapter 1: Hello world');
    expect(artifacts.imagePages).toEqual([2]);
  });

  it('returns review_failed when deterministic QA throws before the report is built', async () => {
    const printResult: PrintQaAssetUrls = {
      interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
      coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
    };

    jest.spyOn(StoryService.prototype, 'getStoryForPrint').mockResolvedValue({
      title: 'QA Failure Story',
      chapters: [],
    } as any);
    jest.spyOn(PrintQualityService.prototype as any, 'downloadAssets').mockResolvedValue({
      interiorPdfBuffer: Buffer.from('stub'),
      coverPdfBuffer: Buffer.from('stub'),
      interiorHtml: '<html></html>',
      coverHtml: '<html></html>',
      printResult,
    });
    jest
      .spyOn(PrintQualityService.prototype as any, 'runDeterministicChecks')
      .mockRejectedValue(new Error('deterministic QA exploded'));

    const result = await new PrintQualityService().execute({
      storyId: 'story-qa-failure',
      runId: 'run-qa-failure',
      printResult,
    });

    expect(result).toEqual(
      expect.objectContaining({
        qaStatus: 'review_failed',
        reportUrl: null,
        alertNeeded: true,
        printResult,
      }),
    );
    expect(result.criticalErrors).toEqual([
      expect.objectContaining({
        code: 'print_qa_review_failed',
        severity: 'critical',
        details: {
          error: 'deterministic QA exploded',
        },
      }),
    ]);
  });

  it('builds identical baseline signatures for repeated QA states', () => {
    const repeatedSignature = buildAutoFixBaselineSignature({
      analysis: buildDeterministicAnalysis([4]),
    } as any);
    const sameSignature = buildAutoFixBaselineSignature({
      analysis: buildDeterministicAnalysis([4]),
    } as any);
    const changedSignature = buildAutoFixBaselineSignature({
      analysis: buildDeterministicAnalysis([1, 4]),
    } as any);

    expect(sameSignature).toBe(repeatedSignature);
    expect(changedSignature).not.toBe(repeatedSignature);
  });

  it('iteratively escalates sparse chapter fixes until chapters 1, 3, and 4 all clear', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mythoria-print-quality-test-'));
    const printResult: PrintQaAssetUrls = {
      interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
      coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
    };

    try {
      const service = new PrintQualityService() as any;
      const generatePrintSetMock = jest
        .spyOn(service.printService, 'generatePrintSet')
        .mockRejectedValue(new Error('generatePrintSet should not be used for QA attempts'));
      const generateInteriorVariantMock = jest
        .spyOn(service.printService, 'generateInteriorVariant')
        .mockImplementation(
          async (
            _storyData,
            interiorOutputPath: string,
            options?: {
              chapterLayoutOverrides?: Record<number, unknown>;
            },
          ) => {
            await writeFile(interiorOutputPath, Buffer.from(`interior:${interiorOutputPath}`));
            return {
              interiorPdfPath: interiorOutputPath,
              interiorHtml: JSON.stringify({
                layoutOverrides: options?.chapterLayoutOverrides ?? {},
              }),
              interiorPreProcessedPdfPath: interiorOutputPath.replace(
                '.pdf',
                '_pre-page-processing.pdf',
              ),
              interiorPostProcessedPdfPath: interiorOutputPath,
              imagePageNumbers: [],
            };
          },
        );
      const convertInteriorToCMYKMock = jest
        .spyOn(service.printService, 'convertInteriorToCMYK')
        .mockRejectedValue(new Error('convertInteriorToCMYK should not be used without CMYK'));

      jest.spyOn(service, 'buildStablePrintUrls').mockResolvedValue(printResult);
      jest
        .spyOn(service, 'runDeterministicChecks')
        .mockImplementation(async (_storyData: unknown, assets: { interiorHtml: string }) => {
          const payload = JSON.parse(assets.interiorHtml) as {
            layoutOverrides?: Record<
              number,
              {
                marginLeftMM?: number;
                marginRightMM?: number;
                lineHeightPt?: number;
                paragraphSpacingPt?: number;
              }
            >;
          };
          const layoutOverrides = payload.layoutOverrides ?? {};
          const chapterLevels = {
            1: inferProfileLevel(layoutOverrides[1]),
            3: inferProfileLevel(layoutOverrides[3]),
            4: inferProfileLevel(layoutOverrides[4]),
          };
          const sparseChapterNumbers: number[] = [];

          if (chapterLevels[1] < 1) {
            sparseChapterNumbers.push(1);
          }
          if (chapterLevels[3] < 2) {
            sparseChapterNumbers.push(3);
          }
          if (chapterLevels[4] < 3) {
            sparseChapterNumbers.push(4);
          }

          return buildDeterministicAnalysis(sparseChapterNumbers);
        });

      const result = await service.tryAutoFixSparsePages({
        tempDir,
        storyId: 'story-sparse-iterative',
        storyData: {
          id: 'story-sparse-iterative',
          chapters: [{}, {}, {}, {}],
        },
        baselineAnalysis: buildDeterministicAnalysis([1, 3, 4]),
        baselineAssets: {
          interiorPdfBuffer: Buffer.from('baseline-interior'),
          coverPdfBuffer: Buffer.from('baseline-cover'),
          interiorHtml: JSON.stringify({ layoutOverrides: {} }),
          coverHtml: '<html></html>',
          printResult,
        },
      });

      expect(result).not.toBeNull();
      expect(result?.layoutStrategies).toEqual({
        1: 'tighten-chapter-spacing-soft',
        3: 'tighten-chapter-spacing-medium',
        4: 'tighten-chapter-spacing-strong',
      });
      expect(result?.attemptIndex).toBe(6);
      expect(generateInteriorVariantMock).toHaveBeenCalledTimes(6);
      expect(generatePrintSetMock).not.toHaveBeenCalled();
      expect(convertInteriorToCMYKMock).not.toHaveBeenCalled();
      expect(result?.analysis.criticalErrors).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('promotes the best safe partial sparse fix when one chapter remains unresolved', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mythoria-print-quality-test-'));
    const printResult: PrintQaAssetUrls = {
      interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
      coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
    };

    try {
      const service = new PrintQualityService() as any;
      const generatePrintSetMock = jest
        .spyOn(service.printService, 'generatePrintSet')
        .mockRejectedValue(new Error('generatePrintSet should not be used for QA attempts'));
      const generateInteriorVariantMock = jest
        .spyOn(service.printService, 'generateInteriorVariant')
        .mockImplementation(
          async (
            _storyData,
            interiorOutputPath: string,
            options?: {
              chapterLayoutOverrides?: Record<number, unknown>;
            },
          ) => {
            await writeFile(interiorOutputPath, Buffer.from(`interior:${interiorOutputPath}`));
            return {
              interiorPdfPath: interiorOutputPath,
              interiorHtml: JSON.stringify({
                layoutOverrides: options?.chapterLayoutOverrides ?? {},
              }),
              interiorPreProcessedPdfPath: interiorOutputPath.replace(
                '.pdf',
                '_pre-page-processing.pdf',
              ),
              interiorPostProcessedPdfPath: interiorOutputPath,
              imagePageNumbers: [],
            };
          },
        );
      const convertInteriorToCMYKMock = jest
        .spyOn(service.printService, 'convertInteriorToCMYK')
        .mockRejectedValue(new Error('convertInteriorToCMYK should not be used without CMYK'));

      jest.spyOn(service, 'buildStablePrintUrls').mockResolvedValue(printResult);
      jest
        .spyOn(service, 'runDeterministicChecks')
        .mockImplementation(async (_storyData: unknown, assets: { interiorHtml: string }) => {
          const payload = JSON.parse(assets.interiorHtml) as {
            layoutOverrides?: Record<
              number,
              {
                marginLeftMM?: number;
                marginRightMM?: number;
                lineHeightPt?: number;
                paragraphSpacingPt?: number;
              }
            >;
          };
          const layoutOverrides = payload.layoutOverrides ?? {};
          const chapterLevels = {
            1: inferProfileLevel(layoutOverrides[1]),
            3: inferProfileLevel(layoutOverrides[3]),
            4: inferProfileLevel(layoutOverrides[4]),
          };
          const sparseChapterNumbers: number[] = [];

          if (chapterLevels[1] < 1) {
            sparseChapterNumbers.push(1);
          }
          if (chapterLevels[3] < 2) {
            sparseChapterNumbers.push(3);
          }
          sparseChapterNumbers.push(4);

          return buildDeterministicAnalysis(sparseChapterNumbers);
        });

      const result = await service.tryAutoFixSparsePages({
        tempDir,
        storyId: 'story-sparse-partial',
        storyData: {
          id: 'story-sparse-partial',
          chapters: [{}, {}, {}, {}],
        },
        baselineAnalysis: buildDeterministicAnalysis([1, 3, 4]),
        baselineAssets: {
          interiorPdfBuffer: Buffer.from('baseline-interior'),
          coverPdfBuffer: Buffer.from('baseline-cover'),
          interiorHtml: JSON.stringify({ layoutOverrides: {} }),
          coverHtml: '<html></html>',
          printResult,
        },
      });

      expect(result).not.toBeNull();
      expect(result?.layoutStrategies).toEqual({
        1: 'tighten-chapter-spacing-soft',
        3: 'tighten-chapter-spacing-medium',
      });
      expect(result?.analysis.criticalErrors).toEqual([
        expect.objectContaining({
          code: 'chapter_sparse_last_page',
          chapterNumber: 4,
        }),
      ]);
      expect(result?.attemptIndex).toBe(3);
      expect(generateInteriorVariantMock).toHaveBeenCalledTimes(8);
      expect(generatePrintSetMock).not.toHaveBeenCalled();
      expect(convertInteriorToCMYKMock).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('defers interior CMYK conversion until the final accepted sparse fix', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'mythoria-print-quality-test-'));
    const printResult: PrintQaAssetUrls = {
      interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
      coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
      interiorCmykPdfUrl: 'https://storage.googleapis.com/bucket/interior_cmyk.pdf',
      coverCmykPdfUrl: 'https://storage.googleapis.com/bucket/cover_cmyk.pdf',
    };

    try {
      const service = new PrintQualityService() as any;
      const generatePrintSetMock = jest
        .spyOn(service.printService, 'generatePrintSet')
        .mockRejectedValue(new Error('generatePrintSet should not be used for QA attempts'));
      const generateInteriorVariantMock = jest
        .spyOn(service.printService, 'generateInteriorVariant')
        .mockImplementation(
          async (
            _storyData,
            interiorOutputPath: string,
            options?: {
              chapterLayoutOverrides?: Record<number, unknown>;
            },
          ) => {
            await writeFile(interiorOutputPath, Buffer.from(`interior:${interiorOutputPath}`));
            return {
              interiorPdfPath: interiorOutputPath,
              interiorHtml: JSON.stringify({
                layoutOverrides: options?.chapterLayoutOverrides ?? {},
              }),
              interiorPreProcessedPdfPath: interiorOutputPath.replace(
                '.pdf',
                '_pre-page-processing.pdf',
              ),
              interiorPostProcessedPdfPath: interiorOutputPath,
              imagePageNumbers: [],
            };
          },
        );
      const convertInteriorToCMYKMock = jest
        .spyOn(service.printService, 'convertInteriorToCMYK')
        .mockImplementation(async (interiorPdfPath: string) => {
          const interiorCmykPath = interiorPdfPath.replace('.pdf', '-cmyk.pdf');
          await writeFile(interiorCmykPath, Buffer.from(`cmyk:${interiorPdfPath}`));
          return interiorCmykPath;
        });

      jest
        .spyOn(service, 'buildStablePrintUrls')
        .mockImplementation(
          async (
            _storyId: string,
            options: { interiorCmykGenerated: boolean; coverCmykGenerated: boolean },
          ) => ({
            interiorPdfUrl: printResult.interiorPdfUrl,
            coverPdfUrl: printResult.coverPdfUrl,
            interiorCmykPdfUrl: options.interiorCmykGenerated
              ? printResult.interiorCmykPdfUrl
              : null,
            coverCmykPdfUrl: options.coverCmykGenerated ? printResult.coverCmykPdfUrl : null,
          }),
        );
      jest
        .spyOn(service, 'runDeterministicChecks')
        .mockImplementation(async (_storyData: unknown, assets: { interiorHtml: string }) => {
          const payload = JSON.parse(assets.interiorHtml) as {
            layoutOverrides?: Record<
              number,
              {
                marginLeftMM?: number;
                marginRightMM?: number;
                lineHeightPt?: number;
                paragraphSpacingPt?: number;
              }
            >;
          };
          const layoutOverrides = payload.layoutOverrides ?? {};
          const chapterLevels = {
            1: inferProfileLevel(layoutOverrides[1]),
            3: inferProfileLevel(layoutOverrides[3]),
            4: inferProfileLevel(layoutOverrides[4]),
          };
          const sparseChapterNumbers: number[] = [];

          if (chapterLevels[1] < 1) {
            sparseChapterNumbers.push(1);
          }
          if (chapterLevels[3] < 2) {
            sparseChapterNumbers.push(3);
          }
          if (chapterLevels[4] < 3) {
            sparseChapterNumbers.push(4);
          }

          return buildDeterministicAnalysis(sparseChapterNumbers);
        });

      const result = await service.tryAutoFixSparsePages({
        tempDir,
        storyId: 'story-sparse-cmyk',
        storyData: {
          id: 'story-sparse-cmyk',
          chapters: [{}, {}, {}, {}],
        },
        baselineAnalysis: buildDeterministicAnalysis([1, 3, 4]),
        baselineAssets: {
          interiorPdfBuffer: Buffer.from('baseline-interior'),
          coverPdfBuffer: Buffer.from('baseline-cover'),
          interiorHtml: JSON.stringify({ layoutOverrides: {} }),
          coverHtml: '<html></html>',
          printResult,
        },
      });

      expect(result).not.toBeNull();
      expect(result?.analysis.criticalErrors).toEqual([]);
      expect(result?.printResult.interiorCmykPdfUrl).toBe(printResult.interiorCmykPdfUrl);
      expect(result?.interiorCmykBuffer).toBeTruthy();
      expect(generateInteriorVariantMock).toHaveBeenCalledTimes(6);
      expect(generatePrintSetMock).not.toHaveBeenCalled();
      expect(convertInteriorToCMYKMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('maps mixed per-chapter auto-fix strategies into passed_with_fixes results', async () => {
    const requestedPrintResult: PrintQaAssetUrls = {
      interiorPdfUrl: '',
      coverPdfUrl: '',
    };
    const printResult: PrintQaAssetUrls = {
      interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
      coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
      interiorCmykPdfUrl: 'https://storage.googleapis.com/bucket/interior_cmyk.pdf',
      coverCmykPdfUrl: 'https://storage.googleapis.com/bucket/cover_cmyk.pdf',
    };

    jest.spyOn(StoryService.prototype, 'getStoryForPrint').mockResolvedValue({
      id: 'story-qa-fixed',
      title: 'Sparse Ending Story',
      chapters: [{}, {}, {}, {}],
    } as any);
    jest.spyOn(StoryService.prototype, 'updateStoryPrintUrls').mockResolvedValue(undefined as any);
    jest.spyOn(PrintQualityService.prototype as any, 'downloadAssets').mockResolvedValue({
      interiorPdfBuffer: Buffer.from('baseline-interior'),
      coverPdfBuffer: Buffer.from('baseline-cover'),
      interiorHtml: '<html></html>',
      coverHtml: '<html></html>',
      printResult,
    });
    jest
      .spyOn(PrintQualityService.prototype as any, 'runDeterministicChecks')
      .mockResolvedValue(buildDeterministicAnalysis([1, 3, 4]));
    jest.spyOn(PrintQualityService.prototype as any, 'tryAutoFixSparsePages').mockResolvedValue({
      attemptIndex: 12,
      strategy: 'iterative-sparse-fix',
      layoutOverrides: {
        1: {
          marginLeftMM: 20.25,
          marginRightMM: 20.25,
        },
        3: {
          marginLeftMM: 19.5,
          marginRightMM: 19.5,
        },
        4: {
          marginLeftMM: 18.75,
          marginRightMM: 18.75,
        },
      },
      layoutStrategies: {
        1: 'tighten-chapter-spacing-soft',
        3: 'tighten-chapter-spacing-medium',
        4: 'tighten-chapter-spacing-strong',
      },
      profileLevels: {
        1: 1,
        3: 2,
        4: 3,
      },
      aggressionScore: 6,
      printResult,
      interiorPdfPath: null,
      interiorPdfBuffer: Buffer.from('fixed-interior'),
      interiorHtml: '<html>fixed</html>',
      interiorCmykBuffer: Buffer.from('fixed-cmyk'),
      analysis: buildDeterministicAnalysis([]),
    });
    jest
      .spyOn(PrintQualityService.prototype as any, 'archiveAndPromoteAcceptedFix')
      .mockResolvedValue(undefined);
    jest.spyOn(PrintQualityService.prototype as any, 'runVisualAiReview').mockResolvedValue({
      passes: [],
      warnings: [],
      criticalErrors: [],
      previews: [],
    });
    jest
      .spyOn(PrintQualityService.prototype as any, 'uploadQaReport')
      .mockResolvedValue('https://storage.googleapis.com/bucket/report.json');

    const result = await new PrintQualityService().execute({
      storyId: 'story-qa-fixed',
      runId: 'run-qa-fixed',
      printResult: requestedPrintResult,
    });

    expect(result.qaStatus).toBe('passed_with_fixes');
    expect(result.alertNeeded).toBe(false);
    expect(result.fixesApplied).toEqual([
      expect.objectContaining({
        chapterNumber: 1,
        strategy: 'tighten-chapter-spacing-soft',
      }),
      expect.objectContaining({
        chapterNumber: 3,
        strategy: 'tighten-chapter-spacing-medium',
      }),
      expect.objectContaining({
        chapterNumber: 4,
        strategy: 'tighten-chapter-spacing-strong',
      }),
    ]);
  });

  it('keeps critical_issues_remaining while promoting safe partial sparse fixes', async () => {
    const requestedPrintResult: PrintQaAssetUrls = {
      interiorPdfUrl: '',
      coverPdfUrl: '',
    };
    const printResult: PrintQaAssetUrls = {
      interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior.pdf',
      coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
    };
    const partialPrintResult: PrintQaAssetUrls = {
      interiorPdfUrl: 'https://storage.googleapis.com/bucket/interior-partial.pdf',
      coverPdfUrl: 'https://storage.googleapis.com/bucket/cover.pdf',
    };

    jest.spyOn(StoryService.prototype, 'getStoryForPrint').mockResolvedValue({
      id: 'story-qa-unresolved',
      title: 'Still Sparse Story',
      chapters: [{}, {}, {}, {}],
    } as any);
    jest.spyOn(StoryService.prototype, 'updateStoryPrintUrls').mockResolvedValue(undefined as any);
    jest.spyOn(PrintQualityService.prototype as any, 'downloadAssets').mockResolvedValue({
      interiorPdfBuffer: Buffer.from('baseline-interior'),
      coverPdfBuffer: Buffer.from('baseline-cover'),
      interiorHtml: '<html></html>',
      coverHtml: '<html></html>',
      printResult,
    });
    jest
      .spyOn(PrintQualityService.prototype as any, 'runDeterministicChecks')
      .mockResolvedValue(buildDeterministicAnalysis([1, 3, 4]));
    jest.spyOn(PrintQualityService.prototype as any, 'tryAutoFixSparsePages').mockResolvedValue({
      attemptIndex: 18,
      strategy: 'partial-sparse-fix',
      layoutOverrides: {
        1: {
          marginLeftMM: 20.25,
          marginRightMM: 20.25,
        },
        3: {
          marginLeftMM: 19.5,
          marginRightMM: 19.5,
        },
      },
      layoutStrategies: {
        1: 'tighten-chapter-spacing-soft',
        3: 'tighten-chapter-spacing-medium',
      },
      profileLevels: {
        1: 1,
        3: 2,
      },
      aggressionScore: 3,
      printResult: partialPrintResult,
      interiorPdfPath: null,
      interiorPdfBuffer: Buffer.from('partial-interior'),
      interiorHtml: '<html>partial</html>',
      interiorCmykBuffer: null,
      analysis: buildDeterministicAnalysis([4]),
    });
    jest
      .spyOn(PrintQualityService.prototype as any, 'archiveAndPromoteAcceptedFix')
      .mockResolvedValue(undefined);
    jest.spyOn(PrintQualityService.prototype as any, 'runVisualAiReview').mockResolvedValue({
      passes: [],
      warnings: [],
      criticalErrors: [],
      previews: [],
    });
    jest
      .spyOn(PrintQualityService.prototype as any, 'uploadQaReport')
      .mockResolvedValue('https://storage.googleapis.com/bucket/report.json');

    const result = await new PrintQualityService().execute({
      storyId: 'story-qa-unresolved',
      runId: 'run-qa-unresolved',
      printResult: requestedPrintResult,
    });

    expect(result.qaStatus).toBe('critical_issues_remaining');
    expect(result.alertNeeded).toBe(true);
    expect(result.criticalCount).toBe(1);
    expect(result.fixesApplied).toEqual([
      expect.objectContaining({
        chapterNumber: 1,
        strategy: 'tighten-chapter-spacing-soft',
      }),
      expect.objectContaining({
        chapterNumber: 3,
        strategy: 'tighten-chapter-spacing-medium',
      }),
    ]);
    expect(result.printResult).toEqual(partialPrintResult);
  });
});
