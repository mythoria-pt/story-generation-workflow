import { mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { PDFParse } from 'pdf-parse';
import { getEnvironment } from '@/config/environment.js';
import { logger } from '@/config/logger.js';
import { GoogleGenAITextService } from '@/ai/providers/google-genai/text.js';
import { PromptService } from '@/services/prompt.js';
import { PrintService } from '@/services/print.js';
import {
  buildIssueComparisonKey,
  buildChapterLayoutOverrideAttempts,
  buildChapterRanges,
  buildIssueKey,
  buildManualNextSteps,
  derivePrintQaStatus,
  detectDoubleSpaceSnippets,
  detectInlineFontSizeOverrides,
  detectSafeZoneViolations,
  detectSparseChapterEndings,
  detectUnexpectedBlankPages,
  evaluateAutoFixCandidate,
  extractSparseChapterNumbers,
  extractCoverSignals,
  extractMarginSnapshot,
  findChapterStartPages,
  getMinimumMarginMM,
  type AutoFixCandidateAssessment,
  type ChapterPageReference,
  type PageTextEntry,
} from '@/services/print-quality-rules.js';
import { StoryService } from '@/services/story.js';
import { getStorageService } from '@/services/storage-singleton.js';
import { PRINT_FRONT_MATTER_PAGE_COUNT } from '@/services/print-layout-constants.js';
import type {
  ChapterLayoutOverride,
  PrintQaAssetUrls,
  PrintQaCheckResult,
  PrintQaFixApplied,
  PrintQaIssue,
  PrintQaPreview,
  PrintQaReport,
} from '@/types/print-quality.js';

interface DeterministicAnalysis {
  totalInteriorPages: number;
  pageTexts: PageTextEntry[];
  imagePages: Set<number>;
  chapterRanges: ChapterPageReference[];
  passes: string[];
  warnings: PrintQaIssue[];
  criticalErrors: PrintQaIssue[];
}

interface RuntimeAssets {
  interiorPdfBuffer: Buffer;
  coverPdfBuffer: Buffer;
  interiorHtml: string;
  coverHtml: string;
  printResult: PrintQaAssetUrls;
}

interface GeneratedAttempt {
  attemptIndex: number;
  strategy: string;
  layoutOverrides: Record<number, ChapterLayoutOverride>;
  layoutStrategies: Record<number, string>;
  profileLevels: Record<number, number>;
  aggressionScore: number;
  printResult: PrintQaAssetUrls;
  interiorPdfPath: string | null;
  interiorPdfBuffer: Buffer;
  interiorHtml: string;
  interiorCmykBuffer: Buffer | null;
  analysis: DeterministicAnalysis;
}

interface AutoFixBaselineSignatureParts {
  totalInteriorPages: number;
  chapterRanges: Array<{
    chapterNumber: number;
    startPage: number;
    endPage: number;
  }>;
  criticalIssueComparisonKeys: string[];
  sparseChapterNumbers: number[];
}

const MINIMUM_SAFE_MARGIN_MM = 5;
const MAX_CHAPTER_PREVIEWS = 6;
const MAX_AUTO_FIX_RENDER_ATTEMPTS = 36;

const VISUAL_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    passes: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          pageHint: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['code', 'message'],
      },
      maxItems: 10,
    },
    criticalErrors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          pageHint: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['code', 'message'],
      },
      maxItems: 10,
    },
    manualNextSteps: {
      type: 'array',
      items: { type: 'string' },
      maxItems: 10,
    },
  },
  required: ['passes', 'warnings', 'criticalErrors', 'manualNextSteps'],
} as const;

function dedupeIssues(issues: PrintQaIssue[]): PrintQaIssue[] {
  const uniqueIssues = new Map<string, PrintQaIssue>();
  for (const issue of issues) {
    const key = buildIssueKey(issue);
    if (!uniqueIssues.has(key)) {
      uniqueIssues.set(key, issue);
    }
  }
  return [...uniqueIssues.values()];
}

function toPrintIssue(
  severity: 'warning' | 'critical',
  issue: {
    code: string;
    message: string;
    pageHint?: string;
    suggestedFix?: string;
  },
): PrintQaIssue {
  return {
    code: issue.code,
    severity,
    message: issue.pageHint ? `${issue.message} (${issue.pageHint})` : issue.message,
    ...(issue.suggestedFix ? { suggestedFix: issue.suggestedFix } : {}),
  };
}

export function buildAutoFixBaselineSignature(attempt: Pick<GeneratedAttempt, 'analysis'>): string {
  const signature: AutoFixBaselineSignatureParts = {
    totalInteriorPages: attempt.analysis.totalInteriorPages,
    chapterRanges: attempt.analysis.chapterRanges.map((range) => ({
      chapterNumber: range.chapterNumber,
      startPage: range.startPage,
      endPage: range.endPage,
    })),
    criticalIssueComparisonKeys: attempt.analysis.criticalErrors
      .map(buildIssueComparisonKey)
      .sort(),
    sparseChapterNumbers: extractSparseChapterNumbers(attempt.analysis.criticalErrors),
  };

  return JSON.stringify(signature);
}

export class PrintQualityService {
  private readonly storageService = getStorageService();
  private readonly storyService = new StoryService();
  private readonly printService = new PrintService();

  async execute(params: {
    storyId: string;
    runId: string;
    printResult: PrintQaAssetUrls;
  }): Promise<PrintQaCheckResult> {
    const tempDir = await mkdtemp(join(tmpdir(), 'mythoria-print-qa-'));

    try {
      const storyData = await this.storyService.getStoryForPrint(params.storyId);
      if (!storyData) {
        throw new Error(`Story not found for print QA: ${params.storyId}`);
      }

      let assets = await this.downloadAssets(storyData, params.storyId, params.printResult);
      let deterministic = await this.runDeterministicChecks(storyData, assets);
      let fixesApplied: PrintQaFixApplied[] = [];

      const autoFixResult = await this.tryAutoFixSparsePages({
        tempDir,
        storyId: params.storyId,
        storyData,
        baselineAnalysis: deterministic,
        baselineAssets: assets,
      });

      if (autoFixResult) {
        assets = {
          ...assets,
          interiorPdfBuffer: autoFixResult.interiorPdfBuffer,
          interiorHtml: autoFixResult.interiorHtml,
          printResult: autoFixResult.printResult,
        };
        deterministic = autoFixResult.analysis;
        fixesApplied = Object.entries(autoFixResult.layoutOverrides)
          .sort(([leftChapterNumber], [rightChapterNumber]) => {
            return parseInt(leftChapterNumber, 10) - parseInt(rightChapterNumber, 10);
          })
          .map(([chapterNumberText, layoutOverride]) => {
            const chapterNumber = parseInt(chapterNumberText, 10);
            return {
              chapterNumber,
              strategy:
                autoFixResult.layoutStrategies[chapterNumber] ?? 'tighten-chapter-spacing-soft',
              layoutOverride,
            };
          });

        await this.archiveAndPromoteAcceptedFix({
          storyId: params.storyId,
          originalInteriorPdfBuffer: params.printResult.interiorPdfUrl
            ? await this.storageService.downloadFileAsBuffer(`${params.storyId}/print/interior.pdf`)
            : assets.interiorPdfBuffer,
          originalInteriorCmykBuffer: params.printResult.interiorCmykPdfUrl
            ? await this.storageService.downloadFileAsBuffer(
                `${params.storyId}/print/interior_cmyk.pdf`,
              )
            : null,
          acceptedAttempt: autoFixResult,
        });

        await this.storyService.updateStoryPrintUrls(params.storyId, {
          interiorPdfUri:
            autoFixResult.printResult.interiorCmykPdfUrl ??
            autoFixResult.printResult.interiorPdfUrl,
          coverPdfUri:
            autoFixResult.printResult.coverCmykPdfUrl ?? autoFixResult.printResult.coverPdfUrl,
        });
      }

      const aiReview = await this.runVisualAiReview({
        storyId: params.storyId,
        storyData,
        assets,
        deterministic,
      });

      const report: PrintQaReport = {
        bookTitle: storyData.title || 'Untitled',
        storyId: params.storyId,
        runId: params.runId,
        generatedAt: new Date().toISOString(),
        totalInteriorPages: deterministic.totalInteriorPages,
        passes: [...deterministic.passes, ...aiReview.passes],
        warnings: dedupeIssues([...deterministic.warnings, ...aiReview.warnings]),
        criticalErrors: dedupeIssues([...deterministic.criticalErrors, ...aiReview.criticalErrors]),
        autoFixesApplied: fixesApplied,
        manualNextSteps: [],
        previews: aiReview.previews,
      };

      const aiSuggestedSteps = aiReview.manualNextSteps ?? [];
      report.manualNextSteps = [...buildManualNextSteps(report), ...aiSuggestedSteps].filter(
        (value, index, array) => value && array.indexOf(value) === index,
      );

      const reportUrl = await this.uploadQaReport(params.storyId, report);
      const qaStatus = derivePrintQaStatus(report);

      return {
        qaStatus,
        reportUrl,
        passCount: report.passes.length,
        warningCount: report.warnings.length,
        criticalCount: report.criticalErrors.length,
        alertNeeded: report.criticalErrors.length > 0,
        fixesApplied,
        criticalErrors: report.criticalErrors,
        warnings: report.warnings,
        printResult: assets.printResult,
      };
    } catch (error) {
      logger.error('Print QA review failed', {
        storyId: params.storyId,
        runId: params.runId,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        qaStatus: 'review_failed',
        reportUrl: null,
        passCount: 0,
        warningCount: 0,
        criticalCount: 1,
        alertNeeded: true,
        fixesApplied: [],
        criticalErrors: [
          {
            code: 'print_qa_review_failed',
            severity: 'critical',
            message: 'The print QA review failed before the report could be completed.',
            details: {
              error: error instanceof Error ? error.message : String(error),
            },
            suggestedFix: 'Inspect the QA service logs and rerun print QA for this story.',
          },
        ],
        warnings: [],
        printResult: params.printResult,
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private estimateRenderPageCount(storyData: { chapters?: unknown[] }): number {
    return (storyData.chapters?.length ?? 0) * 4 + 8;
  }

  private buildInteriorHtml(
    storyData: any,
    chapterLayoutOverrides: Record<number, ChapterLayoutOverride> = {},
  ): string {
    const dimensions = this.printService.calculateDimensions(
      this.estimateRenderPageCount(storyData),
    );
    return this.printService.generateInteriorHTML(storyData, dimensions, {
      chapterLayoutOverrides,
    });
  }

  private buildCoverHtml(storyData: any): string {
    const dimensions = this.printService.calculateDimensions(
      this.estimateRenderPageCount(storyData),
    );
    return this.printService.generateCoverHTML(storyData, dimensions);
  }

  private async downloadAssets(
    storyData: any,
    storyId: string,
    printResult: PrintQaAssetUrls,
  ): Promise<RuntimeAssets> {
    const [interiorPdfBuffer, coverPdfBuffer] = await Promise.all([
      this.storageService.downloadFileAsBuffer(`${storyId}/print/interior.pdf`),
      this.storageService.downloadFileAsBuffer(`${storyId}/print/cover.pdf`),
    ]);

    const [interiorHtml, coverHtml] = await Promise.all([
      this.readHtmlOrRegenerate(
        `${storyId}/print/interior.html`,
        this.buildInteriorHtml(storyData),
      ),
      this.readHtmlOrRegenerate(`${storyId}/print/cover.html`, this.buildCoverHtml(storyData)),
    ]);

    return {
      interiorPdfBuffer,
      coverPdfBuffer,
      interiorHtml,
      coverHtml,
      printResult,
    };
  }

  private async readHtmlOrRegenerate(path: string, fallback: string): Promise<string> {
    try {
      return await this.storageService.downloadFile(path);
    } catch (error) {
      logger.warn('Falling back to regenerated HTML for print QA', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  private async getPdfArtifacts(buffer: Buffer): Promise<{
    pageTexts: PageTextEntry[];
    imagePages: Set<number>;
    totalPages: number;
  }> {
    const parser = new PDFParse({ data: buffer });

    try {
      logger.debug('Print QA PDF artifact extraction started', {
        bufferSize: buffer.length,
      });
      const textResult = await parser.getText();
      logger.debug('Print QA text extraction completed', {
        totalPages: textResult.total,
      });
      const imageResult = await parser.getImage({
        imageThreshold: 0,
        imageBuffer: false,
        imageDataUrl: false,
      });
      const imagePages = imageResult.pages
        .filter((page) => page.images.length > 0)
        .map((page) => page.pageNumber);
      logger.debug('Print QA image extraction completed', {
        imagePageCount: imagePages.length,
        imagePages,
      });

      return {
        pageTexts: textResult.pages.map((page) => ({
          num: page.num,
          text: page.text,
        })),
        imagePages: new Set(imagePages),
        totalPages: textResult.total,
      };
    } finally {
      await parser.destroy();
    }
  }

  private async runDeterministicChecks(
    storyData: any,
    assets: RuntimeAssets,
  ): Promise<DeterministicAnalysis> {
    logger.debug('Print QA deterministic checks started', {
      chapterCount: storyData.chapters?.length ?? 0,
    });
    const pdfArtifacts = await this.getPdfArtifacts(assets.interiorPdfBuffer);
    const passes: string[] = [];
    const warnings: PrintQaIssue[] = [];
    const criticalErrors: PrintQaIssue[] = [];

    const chapterTitles = (storyData.chapters || []).map((chapter: any) => chapter.title || '');
    const chapterStarts = findChapterStartPages(pdfArtifacts.pageTexts, chapterTitles, {
      minimumPageNumber: PRINT_FRONT_MATTER_PAGE_COUNT + 1,
    });
    const missingChapterStarts = chapterStarts.filter((chapter) => chapter.pageNumber === null);
    const foundChapterStarts = chapterStarts.filter((chapter) => chapter.pageNumber !== null);
    logger.debug('Print QA chapter start detection completed', {
      chapterStartPages: foundChapterStarts.map((chapter) => ({
        chapterNumber: chapter.chapterNumber,
        pageNumber: chapter.pageNumber,
      })),
      foundChapterCount: foundChapterStarts.length,
      minimumPageNumber: PRINT_FRONT_MATTER_PAGE_COUNT + 1,
      missingChapterCount: missingChapterStarts.length,
    });
    for (const chapter of missingChapterStarts) {
      criticalErrors.push({
        code: 'chapter_start_not_detected',
        severity: 'critical',
        chapterNumber: chapter.chapterNumber,
        message: `Chapter ${chapter.chapterNumber} could not be located in the generated interior PDF.`,
        suggestedFix:
          'Inspect the chapter title formatting and verify the chapter rendered correctly in the final PDF.',
      });
    }

    if (foundChapterStarts.length === chapterTitles.length && foundChapterStarts.length > 0) {
      passes.push('All chapter openings were detected in the interior PDF.');
    }

    for (const chapter of foundChapterStarts) {
      if ((chapter.pageNumber ?? 0) % 2 === 0) {
        criticalErrors.push({
          code: 'chapter_start_even_page',
          severity: 'critical',
          chapterNumber: chapter.chapterNumber,
          ...(chapter.pageNumber ? { pageNumbers: [chapter.pageNumber] } : {}),
          message: `Chapter ${chapter.chapterNumber} starts on an even-numbered page.`,
          suggestedFix:
            'Insert or reflow content so every chapter begins on an odd-numbered recto page.',
        });
      }
    }
    if (
      foundChapterStarts.length > 0 &&
      !criticalErrors.some((issue) => issue.code === 'chapter_start_even_page')
    ) {
      passes.push('All detected chapters begin on odd-numbered pages.');
    }

    const chapterRanges = buildChapterRanges(chapterStarts, pdfArtifacts.totalPages);
    const sparseEndings = detectSparseChapterEndings(pdfArtifacts.pageTexts, chapterRanges);
    logger.debug('Print QA sparse ending detection completed', {
      sparseEndingCount: sparseEndings.length,
    });
    for (const sparseEnding of sparseEndings) {
      criticalErrors.push({
        code: 'chapter_sparse_last_page',
        severity: 'critical',
        chapterNumber: sparseEnding.chapterNumber,
        pageNumbers: [sparseEnding.pageNumber],
        message: `Chapter ${sparseEnding.chapterNumber} ends on an almost empty page.`,
        details: {
          textLength: sparseEnding.textLength,
          nonEmptyLineCount: sparseEnding.nonEmptyLineCount,
        },
        suggestedFix:
          'Tighten the chapter layout slightly so the last page has a healthier text block before printing.',
      });
    }
    if (sparseEndings.length === 0) {
      passes.push('No sparse chapter-ending pages were detected.');
    }

    const blankPages = detectUnexpectedBlankPages(pdfArtifacts.pageTexts, pdfArtifacts.imagePages);
    logger.debug('Print QA blank page detection completed', {
      blankPageCount: blankPages.length,
      blankPages,
    });
    for (const blankPageNumber of blankPages) {
      criticalErrors.push({
        code: 'unexpected_blank_page',
        severity: 'critical',
        pageNumbers: [blankPageNumber],
        message: `The interior PDF contains an unexpected blank page (${blankPageNumber}).`,
        suggestedFix:
          'Remove or repurpose the blank page unless it is deliberately required for the print layout.',
      });
    }
    if (blankPages.length === 0) {
      passes.push('No unexpected blank pages were found in the interior PDF.');
    }

    const doubleSpaceSnippets = detectDoubleSpaceSnippets(assets.interiorHtml);
    if (doubleSpaceSnippets.length > 0) {
      warnings.push({
        code: 'double_spaces_detected',
        severity: 'warning',
        message:
          'The interior HTML still contains consecutive double spaces in the chapter content.',
        details: {
          snippets: doubleSpaceSnippets,
        },
        suggestedFix:
          'Normalize the chapter HTML before print rendering so spacing stays typographically clean.',
      });
    } else {
      passes.push('No consecutive double spaces were detected in the chapter HTML.');
    }

    const fontSizeOverrides = detectInlineFontSizeOverrides(assets.interiorHtml);
    if (fontSizeOverrides.length > 0) {
      warnings.push({
        code: 'inline_font_size_override',
        severity: 'warning',
        message: 'Inline font-size overrides were found inside chapter content.',
        details: {
          samples: fontSizeOverrides,
        },
        suggestedFix:
          'Remove inline chapter font-size overrides unless the variation is editorially intentional.',
      });
    } else {
      passes.push('No unexpected inline font-size overrides were found in chapter content.');
    }

    const safeZoneIssues = detectSafeZoneViolations(
      extractMarginSnapshot(assets.interiorHtml),
      MINIMUM_SAFE_MARGIN_MM,
    );
    criticalErrors.push(...safeZoneIssues);
    if (safeZoneIssues.length === 0) {
      passes.push(`All detected chapter margins stay at or above ${MINIMUM_SAFE_MARGIN_MM}mm.`);
    }

    const coverSignals = extractCoverSignals(assets.coverHtml);
    if (!coverSignals.hasLogo) {
      criticalErrors.push({
        code: 'cover_logo_missing',
        severity: 'critical',
        message: 'The cover HTML is missing the Mythoria logo on the back cover.',
        suggestedFix:
          'Restore the Mythoria logo on the back cover before submitting the PDF for print.',
      });
    }
    if (!coverSignals.hasQrCode) {
      criticalErrors.push({
        code: 'cover_qr_missing',
        severity: 'critical',
        message: 'The cover HTML is missing the QR code on the back cover.',
        suggestedFix: 'Restore the QR code on the back cover before submitting the PDF for print.',
      });
    }

    if (pdfArtifacts.totalPages < 60 && coverSignals.spineText.length > 0) {
      criticalErrors.push({
        code: 'spine_text_not_allowed',
        severity: 'critical',
        message: 'The cover spine contains text even though the interior has fewer than 60 pages.',
        details: {
          totalInteriorPages: pdfArtifacts.totalPages,
          spineText: coverSignals.spineText,
        },
        suggestedFix:
          'Remove the spine text for low-page-count books so the cover remains legible after trimming and binding.',
      });
    } else {
      passes.push('The cover spine policy matches the current interior page count.');
    }

    logger.debug('Print QA deterministic checks completed', {
      criticalCount: criticalErrors.length,
      passCount: passes.length,
      totalInteriorPages: pdfArtifacts.totalPages,
      warningCount: warnings.length,
    });

    return {
      totalInteriorPages: pdfArtifacts.totalPages,
      pageTexts: pdfArtifacts.pageTexts,
      imagePages: pdfArtifacts.imagePages,
      chapterRanges,
      passes,
      warnings: dedupeIssues(warnings),
      criticalErrors: dedupeIssues(criticalErrors),
    };
  }

  private async tryAutoFixSparsePages(params: {
    tempDir: string;
    storyId: string;
    storyData: any;
    baselineAnalysis: DeterministicAnalysis;
    baselineAssets: RuntimeAssets;
  }): Promise<GeneratedAttempt | null> {
    const initialSparseChapterNumbers = extractSparseChapterNumbers(
      params.baselineAnalysis.criticalErrors,
    );
    if (initialSparseChapterNumbers.length === 0) {
      return null;
    }

    const generateCMYK = !!params.baselineAssets.printResult.interiorCmykPdfUrl;
    let attemptIndex = 0;
    let remainingRenderBudget = MAX_AUTO_FIX_RENDER_ATTEMPTS;
    let currentAcceptedAttempt: GeneratedAttempt = {
      attemptIndex: 0,
      strategy: 'baseline',
      layoutOverrides: {},
      layoutStrategies: {},
      profileLevels: {},
      aggressionScore: 0,
      printResult: params.baselineAssets.printResult,
      interiorPdfPath: null,
      interiorPdfBuffer: params.baselineAssets.interiorPdfBuffer,
      interiorHtml: params.baselineAssets.interiorHtml,
      interiorCmykBuffer: null,
      analysis: params.baselineAnalysis,
    };
    const seenBaselineSignatures = new Set<string>([
      buildAutoFixBaselineSignature(currentAcceptedAttempt),
    ]);

    while (remainingRenderBudget > 0) {
      const unresolvedSparseChapterNumbers = extractSparseChapterNumbers(
        currentAcceptedAttempt.analysis.criticalErrors,
      );

      if (unresolvedSparseChapterNumbers.length === 0) {
        break;
      }

      const attempts = buildChapterLayoutOverrideAttempts({
        currentProfileLevels: currentAcceptedAttempt.profileLevels,
        unresolvedChapterNumbers: unresolvedSparseChapterNumbers,
      });
      if (attempts.length === 0) {
        break;
      }

      const baselineCriticalIssueComparisonKeys =
        currentAcceptedAttempt.analysis.criticalErrors.map(buildIssueComparisonKey);
      let acceptedCandidateThisPass = false;
      for (const attempt of attempts) {
        if (remainingRenderBudget <= 0) {
          break;
        }

        attemptIndex += 1;
        remainingRenderBudget -= 1;

        const attemptDir = join(params.tempDir, `attempt-${attemptIndex}`);
        await mkdir(attemptDir, { recursive: true });

        const interiorOutputPath = join(attemptDir, 'interior.pdf');
        logger.debug('Print QA sparse auto-fix candidate started', {
          storyId: params.storyId,
          attemptIndex,
          strategy: attempt.strategy,
          layoutStrategies: attempt.layoutStrategies,
          profileLevels: attempt.profileLevels,
          baselineSparseChapters: unresolvedSparseChapterNumbers,
          remainingRenderBudget,
        });

        const interiorVariant = await this.printService.generateInteriorVariant(
          params.storyData,
          interiorOutputPath,
          {
            chapterLayoutOverrides: attempt.layoutOverrides,
          },
        );

        const interiorPdfBuffer = await readFile(interiorVariant.interiorPdfPath);
        const attemptPrintResult = await this.buildStablePrintUrls(params.storyId, {
          interiorCmykGenerated: false,
          coverCmykGenerated: !!params.baselineAssets.printResult.coverCmykPdfUrl,
        });

        const analysis = await this.runDeterministicChecks(params.storyData, {
          ...params.baselineAssets,
          interiorPdfBuffer,
          interiorHtml: interiorVariant.interiorHtml,
          printResult: attemptPrintResult,
        });

        const candidateAssessment: AutoFixCandidateAssessment = {
          attemptIndex,
          strategy: attempt.strategy,
          layoutOverrides: attempt.layoutOverrides,
          layoutStrategies: attempt.layoutStrategies,
          profileLevels: attempt.profileLevels,
          criticalIssueComparisonKeys: analysis.criticalErrors.map(buildIssueComparisonKey),
          sparseChapterNumbers: extractSparseChapterNumbers(analysis.criticalErrors),
          minMarginMM: getMinimumMarginMM(attempt.layoutOverrides),
          aggressionScore: attempt.aggressionScore,
        };

        const evaluation = evaluateAutoFixCandidate({
          baselineCriticalIssueComparisonKeys,
          baselineSparseChapterNumbers: unresolvedSparseChapterNumbers,
          candidate: candidateAssessment,
          minimumSafeMarginMM: MINIMUM_SAFE_MARGIN_MM,
        });

        logger.debug('Print QA sparse auto-fix candidate evaluated', {
          storyId: params.storyId,
          attemptIndex: evaluation.candidate.attemptIndex,
          strategy: evaluation.candidate.strategy,
          layoutStrategies: evaluation.candidate.layoutStrategies,
          profileLevels: evaluation.candidate.profileLevels,
          baselineSparseChapters: unresolvedSparseChapterNumbers,
          candidateSparseChapters: evaluation.candidate.sparseChapterNumbers,
          resolvedSparseIssueCount: evaluation.resolvedSparseIssueCount,
          remainingSparseIssueCount: evaluation.remainingSparseIssueCount,
          newCriticalIssueKeys: evaluation.newCriticalIssueKeys,
          rejectionReasons: evaluation.rejectionReasons,
          minMarginMM: evaluation.candidate.minMarginMM,
          acceptedAsBaseline: evaluation.qualifies,
        });

        if (!evaluation.qualifies) {
          logger.debug('Print QA sparse auto-fix candidate rejected', {
            storyId: params.storyId,
            attemptIndex,
            strategy: attempt.strategy,
            rejectionReasons: evaluation.rejectionReasons,
            baselineSparseChapters: unresolvedSparseChapterNumbers,
            candidateSparseChapters: evaluation.candidate.sparseChapterNumbers,
          });
          continue;
        }

        const nextAcceptedAttempt: GeneratedAttempt = {
          attemptIndex,
          strategy: attempt.strategy,
          layoutOverrides: attempt.layoutOverrides,
          layoutStrategies: attempt.layoutStrategies,
          profileLevels: attempt.profileLevels,
          aggressionScore: attempt.aggressionScore,
          printResult: attemptPrintResult,
          interiorPdfPath: interiorVariant.interiorPdfPath,
          interiorPdfBuffer,
          interiorHtml: interiorVariant.interiorHtml,
          interiorCmykBuffer: null,
          analysis,
        };

        const nextBaselineSignature = buildAutoFixBaselineSignature(nextAcceptedAttempt);
        if (seenBaselineSignatures.has(nextBaselineSignature)) {
          logger.warn('Print QA sparse auto-fix detected a repeated baseline state', {
            storyId: params.storyId,
            acceptedAttemptIndex: nextAcceptedAttempt.attemptIndex,
            strategy: nextAcceptedAttempt.strategy,
            fixedChapterNumbers: Object.keys(nextAcceptedAttempt.layoutOverrides).map((value) =>
              parseInt(value, 10),
            ),
            remainingSparseChapters: extractSparseChapterNumbers(
              nextAcceptedAttempt.analysis.criticalErrors,
            ),
            remainingRenderBudget,
          });
          const finalizedAttempt = await this.finalizeAcceptedAttempt({
            storyId: params.storyId,
            storyData: params.storyData,
            acceptedAttempt: currentAcceptedAttempt,
            generateCMYK,
            coverCmykGenerated: !!params.baselineAssets.printResult.coverCmykPdfUrl,
          });
          return finalizedAttempt?.attemptIndex ? finalizedAttempt : null;
        }

        currentAcceptedAttempt = nextAcceptedAttempt;
        seenBaselineSignatures.add(nextBaselineSignature);
        acceptedCandidateThisPass = true;

        const remainingSparseChapters = extractSparseChapterNumbers(
          nextAcceptedAttempt.analysis.criticalErrors,
        );

        if (remainingSparseChapters.length === 0) {
          logger.info('Print QA sparse auto-fix fully resolved all target chapters early', {
            storyId: params.storyId,
            acceptedAttemptIndex: nextAcceptedAttempt.attemptIndex,
            strategy: nextAcceptedAttempt.strategy,
            fixedChapterNumbers: Object.keys(nextAcceptedAttempt.layoutOverrides).map((value) =>
              parseInt(value, 10),
            ),
            totalAttemptsUsed: attemptIndex,
            remainingRenderBudget,
          });

          return await this.finalizeAcceptedAttempt({
            storyId: params.storyId,
            storyData: params.storyData,
            acceptedAttempt: currentAcceptedAttempt,
            generateCMYK,
            coverCmykGenerated: !!params.baselineAssets.printResult.coverCmykPdfUrl,
          });
        }

        logger.info('Print QA sparse auto-fix advanced internal baseline', {
          storyId: params.storyId,
          acceptedAttemptIndex: nextAcceptedAttempt.attemptIndex,
          strategy: nextAcceptedAttempt.strategy,
          fixedChapterNumbers: Object.keys(nextAcceptedAttempt.layoutOverrides).map((value) =>
            parseInt(value, 10),
          ),
          remainingSparseChapters,
          remainingRenderBudget,
        });
        break;
      }

      if (!acceptedCandidateThisPass) {
        logger.debug('Print QA sparse auto-fix exhausted current baseline candidates', {
          storyId: params.storyId,
          baselineSparseChapters: unresolvedSparseChapterNumbers,
          remainingRenderBudget,
        });
        break;
      }
    }

    const unresolvedSparseChapterNumbers = extractSparseChapterNumbers(
      currentAcceptedAttempt.analysis.criticalErrors,
    );
    if (unresolvedSparseChapterNumbers.length === 0 && currentAcceptedAttempt.attemptIndex > 0) {
      const finalizedAttempt = await this.finalizeAcceptedAttempt({
        storyId: params.storyId,
        storyData: params.storyData,
        acceptedAttempt: currentAcceptedAttempt,
        generateCMYK,
        coverCmykGenerated: !!params.baselineAssets.printResult.coverCmykPdfUrl,
      });

      logger.info('Print QA sparse auto-fix fully resolved all target chapters', {
        storyId: params.storyId,
        fixedChapterNumbers: Object.keys(finalizedAttempt.layoutOverrides).map((value) =>
          parseInt(value, 10),
        ),
        totalAttemptsUsed: attemptIndex,
      });
      return finalizedAttempt;
    }

    if (currentAcceptedAttempt.attemptIndex > 0) {
      const finalizedAttempt = await this.finalizeAcceptedAttempt({
        storyId: params.storyId,
        storyData: params.storyData,
        acceptedAttempt: currentAcceptedAttempt,
        generateCMYK,
        coverCmykGenerated: !!params.baselineAssets.printResult.coverCmykPdfUrl,
      });

      logger.info('Print QA sparse auto-fix promoted best safe partial improvement', {
        storyId: params.storyId,
        fixedChapterNumbers: Object.keys(finalizedAttempt.layoutOverrides).map((value) =>
          parseInt(value, 10),
        ),
        remainingSparseChapters: unresolvedSparseChapterNumbers,
        totalAttemptsUsed: attemptIndex,
        remainingRenderBudget,
      });
      return finalizedAttempt;
    }

    logger.warn('Print QA sparse auto-fix stopped before resolving every sparse chapter', {
      storyId: params.storyId,
      remainingSparseChapters: unresolvedSparseChapterNumbers,
      totalAttemptsUsed: attemptIndex,
      remainingRenderBudget,
    });

    return null;
  }

  private async finalizeAcceptedAttempt(params: {
    storyId: string;
    storyData: any;
    acceptedAttempt: GeneratedAttempt;
    generateCMYK: boolean;
    coverCmykGenerated: boolean;
  }): Promise<GeneratedAttempt> {
    if (
      !params.generateCMYK ||
      params.acceptedAttempt.attemptIndex === 0 ||
      !params.acceptedAttempt.interiorPdfPath
    ) {
      return params.acceptedAttempt;
    }

    try {
      const interiorCmykPdfPath = await this.printService.convertInteriorToCMYK(
        params.acceptedAttempt.interiorPdfPath,
        params.storyData,
        [...params.acceptedAttempt.analysis.imagePages].sort((a, b) => a - b),
      );
      const [interiorCmykBuffer, printResult] = await Promise.all([
        readFile(interiorCmykPdfPath),
        this.buildStablePrintUrls(params.storyId, {
          interiorCmykGenerated: true,
          coverCmykGenerated: params.coverCmykGenerated,
        }),
      ]);

      return {
        ...params.acceptedAttempt,
        printResult,
        interiorCmykBuffer,
      };
    } catch (error) {
      logger.warn('Print QA sparse auto-fix final interior CMYK conversion failed', {
        storyId: params.storyId,
        attemptIndex: params.acceptedAttempt.attemptIndex,
        strategy: params.acceptedAttempt.strategy,
        error: error instanceof Error ? error.message : String(error),
      });

      const printResult = await this.buildStablePrintUrls(params.storyId, {
        interiorCmykGenerated: false,
        coverCmykGenerated: params.coverCmykGenerated,
      });

      return {
        ...params.acceptedAttempt,
        printResult,
        interiorCmykBuffer: null,
      };
    }
  }

  private async archiveAndPromoteAcceptedFix(params: {
    storyId: string;
    originalInteriorPdfBuffer: Buffer;
    originalInteriorCmykBuffer: Buffer | null;
    acceptedAttempt: GeneratedAttempt;
  }): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    await this.storageService.uploadFile(
      `${params.storyId}/print/qa/interior-before-fix-${timestamp}.pdf`,
      params.originalInteriorPdfBuffer,
      'application/pdf',
    );

    if (params.originalInteriorCmykBuffer) {
      await this.storageService.uploadFile(
        `${params.storyId}/print/qa/interior-cmyk-before-fix-${timestamp}.pdf`,
        params.originalInteriorCmykBuffer,
        'application/pdf',
      );
    }

    await this.storageService.uploadFile(
      `${params.storyId}/print/interior.pdf`,
      params.acceptedAttempt.interiorPdfBuffer,
      'application/pdf',
    );

    await this.storageService.uploadFile(
      `${params.storyId}/print/interior.html`,
      Buffer.from(params.acceptedAttempt.interiorHtml, 'utf-8'),
      'text/html',
    );

    if (params.acceptedAttempt.interiorCmykBuffer) {
      await this.storageService.uploadFile(
        `${params.storyId}/print/interior_cmyk.pdf`,
        params.acceptedAttempt.interiorCmykBuffer,
        'application/pdf',
      );
    }
  }

  private async buildStablePrintUrls(
    storyId: string,
    options: { interiorCmykGenerated: boolean; coverCmykGenerated: boolean },
  ): Promise<PrintQaAssetUrls> {
    const [interiorPdfUrl, coverPdfUrl, interiorCmykPdfUrl, coverCmykPdfUrl] = await Promise.all([
      this.storageService.getPublicUrl(`${storyId}/print/interior.pdf`),
      this.storageService.getPublicUrl(`${storyId}/print/cover.pdf`),
      options.interiorCmykGenerated
        ? this.storageService.getPublicUrl(`${storyId}/print/interior_cmyk.pdf`)
        : Promise.resolve(null),
      options.coverCmykGenerated
        ? this.storageService.getPublicUrl(`${storyId}/print/cover_cmyk.pdf`)
        : Promise.resolve(null),
    ]);

    return {
      interiorPdfUrl,
      coverPdfUrl,
      interiorCmykPdfUrl,
      coverCmykPdfUrl,
    };
  }

  private async runVisualAiReview(params: {
    storyId: string;
    storyData: any;
    assets: RuntimeAssets;
    deterministic: DeterministicAnalysis;
  }): Promise<{
    passes: string[];
    warnings: PrintQaIssue[];
    criticalErrors: PrintQaIssue[];
    previews: PrintQaPreview[];
    manualNextSteps?: string[];
  }> {
    const previews = await this.renderAndUploadPreviews(
      params.storyId,
      params.assets.coverPdfBuffer,
      params.assets.interiorPdfBuffer,
      params.deterministic.chapterRanges,
    );

    const env = getEnvironment();
    if (!env.GOOGLE_GENAI_API_KEY) {
      return {
        passes: [],
        warnings: [
          {
            code: 'ai_visual_review_skipped',
            severity: 'warning',
            message:
              'The multimodal visual QA review was skipped because GOOGLE_GENAI_API_KEY is not configured.',
            suggestedFix: 'Configure Google GenAI credentials to enable visual pre-press review.',
          },
        ],
        criticalErrors: [],
        previews,
      };
    }

    if (previews.length === 0) {
      return {
        passes: [],
        warnings: [
          {
            code: 'ai_visual_review_skipped',
            severity: 'warning',
            message:
              'The multimodal visual QA review was skipped because preview images were not available.',
            suggestedFix: 'Inspect the preview generation step and rerun the QA review.',
          },
        ],
        criticalErrors: [],
        previews,
      };
    }

    try {
      const promptTemplate = await PromptService.loadSharedPrompt('print-qa-review');
      const previewCatalog = previews
        .map((preview, index) => `${index + 1}. ${preview.label}`)
        .join('\n');
      const prompt = PromptService.buildPrompt(promptTemplate, {
        bookTitle: params.storyData.title || 'Untitled',
        totalInteriorPages: params.deterministic.totalInteriorPages,
        spineTextAllowed: params.deterministic.totalInteriorPages >= 60 ? 'yes' : 'no',
        previewCatalog,
      });

      const textService = new GoogleGenAITextService({
        apiKey: env.GOOGLE_GENAI_API_KEY,
        model: env.GOOGLE_GENAI_MODEL,
      });

      const mediaParts = await Promise.all(
        previews.map(async (preview) => ({
          mimeType: 'image/png',
          data: await this.storageService.downloadFileAsBuffer(preview.storagePath),
        })),
      );

      const responseText = await textService.complete(prompt, {
        model: env.GOOGLE_GENAI_MODEL,
        temperature: 0.1,
        jsonSchema: VISUAL_REVIEW_SCHEMA,
        mediaParts,
      });

      const parsed = JSON.parse(responseText) as {
        passes?: string[];
        warnings?: Array<{
          code: string;
          message: string;
          pageHint?: string;
          suggestedFix?: string;
        }>;
        criticalErrors?: Array<{
          code: string;
          message: string;
          pageHint?: string;
          suggestedFix?: string;
        }>;
        manualNextSteps?: string[];
      };

      return {
        passes: parsed.passes ?? [],
        warnings: (parsed.warnings ?? []).map((issue) => toPrintIssue('warning', issue)),
        criticalErrors: (parsed.criticalErrors ?? []).map((issue) =>
          toPrintIssue('critical', issue),
        ),
        previews,
        manualNextSteps: parsed.manualNextSteps ?? [],
      };
    } catch (error) {
      logger.warn('Visual AI review failed; continuing with deterministic QA only', {
        storyId: params.storyId,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        passes: [],
        warnings: [
          {
            code: 'ai_visual_review_failed',
            severity: 'warning',
            message:
              'The multimodal visual QA review failed, so only deterministic checks were applied.',
            details: {
              error: error instanceof Error ? error.message : String(error),
            },
            suggestedFix:
              'Inspect the Google GenAI response and rerun QA if visual validation is required.',
          },
        ],
        criticalErrors: [],
        previews,
      };
    }
  }

  private async renderAndUploadPreviews(
    storyId: string,
    coverPdfBuffer: Buffer,
    interiorPdfBuffer: Buffer,
    chapterRanges: ChapterPageReference[],
  ): Promise<PrintQaPreview[]> {
    const previews: PrintQaPreview[] = [];

    const coverParser = new PDFParse({ data: coverPdfBuffer });
    try {
      const coverScreenshots = await coverParser.getScreenshot({
        desiredWidth: 1400,
        first: 1,
        imageDataUrl: false,
      });
      const coverPage = coverScreenshots.pages[0];
      if (coverPage?.data) {
        const storagePath = `${storyId}/print/qa/cover-preview.png`;
        const url = await this.storageService.uploadFile(
          storagePath,
          Buffer.from(coverPage.data),
          'image/png',
        );
        previews.push({
          key: 'cover-preview',
          label: 'Cover spread preview',
          storagePath,
          url,
        });
      }
    } finally {
      await coverParser.destroy();
    }

    const chapterPreviewPages = chapterRanges
      .slice(0, MAX_CHAPTER_PREVIEWS)
      .map((range) => range.startPage)
      .filter((value) => Number.isFinite(value));

    if (chapterPreviewPages.length === 0) {
      return previews;
    }

    const interiorParser = new PDFParse({ data: interiorPdfBuffer });
    try {
      const screenshots = await interiorParser.getScreenshot({
        desiredWidth: 1200,
        partial: chapterPreviewPages,
        imageDataUrl: false,
      });

      for (const page of screenshots.pages) {
        if (!page?.data) {
          continue;
        }

        const chapter = chapterRanges.find((range) => range.startPage === page.pageNumber);
        const chapterLabel = chapter
          ? `Chapter ${chapter.chapterNumber} opening page`
          : `Interior page ${page.pageNumber}`;
        const storagePath = `${storyId}/print/qa/chapter-preview-page-${page.pageNumber}.png`;
        const url = await this.storageService.uploadFile(
          storagePath,
          Buffer.from(page.data),
          'image/png',
        );

        previews.push({
          key: `chapter-preview-${page.pageNumber}`,
          label: `${chapterLabel} (page ${page.pageNumber})`,
          storagePath,
          url,
        });
      }
    } finally {
      await interiorParser.destroy();
    }

    return previews;
  }

  private async uploadQaReport(storyId: string, report: PrintQaReport): Promise<string | null> {
    try {
      const reportPath = `${storyId}/print/qa/report.json`;
      return await this.storageService.uploadFile(
        reportPath,
        Buffer.from(JSON.stringify(report, null, 2), 'utf-8'),
        'application/json',
      );
    } catch (error) {
      logger.error('Failed to upload print QA report', {
        storyId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
