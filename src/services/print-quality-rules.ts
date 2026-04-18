import { parse } from 'node-html-parser';
import type { ChapterLayoutOverride, PrintQaIssue, PrintQaReport } from '@/types/print-quality.js';
import { PRINT_FRONT_MATTER_PAGE_COUNT } from '@/services/print-layout-constants.js';

export interface PageTextEntry {
  num: number;
  text: string;
}

export interface ChapterPageReference {
  chapterNumber: number;
  title: string;
  startPage: number;
  endPage: number;
}

export interface SparseChapterEnding {
  chapterNumber: number;
  pageNumber: number;
  textLength: number;
  nonEmptyLineCount: number;
}

export interface MarginSnapshot {
  defaultMargins: {
    leftMM: number | null;
    rightMM: number | null;
  };
  chapterMargins: Record<number, { leftMM: number; rightMM: number }>;
}

export interface AutoFixCandidateAssessment {
  attemptIndex: number;
  strategy: string;
  layoutOverrides: Record<number, ChapterLayoutOverride>;
  layoutStrategies: Record<number, string>;
  profileLevels: Record<number, number>;
  criticalIssueComparisonKeys: string[];
  sparseChapterNumbers: number[];
  minMarginMM: number;
  aggressionScore: number;
}

export interface AutoFixCandidateEvaluation {
  candidate: AutoFixCandidateAssessment;
  qualifies: boolean;
  newCriticalIssueKeys: string[];
  resolvedSparseIssueCount: number;
  remainingSparseIssueCount: number;
  rejectionReasons: Array<
    'below_margin_floor' | 'new_critical' | 'no_improvement' | 'still_sparse'
  >;
}

interface ChapterLayoutProfile {
  strategy: string;
  marginLeftMM: number;
  marginRightMM: number;
  lineHeightPt: number;
  paragraphSpacingPt: number;
}

const CHAPTER_LAYOUT_PROFILES: ChapterLayoutProfile[] = [
  {
    strategy: 'tighten-chapter-spacing-soft',
    marginLeftMM: 20.25,
    marginRightMM: 20.25,
    lineHeightPt: 14.8,
    paragraphSpacingPt: 14.7,
  },
  {
    strategy: 'tighten-chapter-spacing-medium',
    marginLeftMM: 19.5,
    marginRightMM: 19.5,
    lineHeightPt: 14.5,
    paragraphSpacingPt: 14.0,
  },
  {
    strategy: 'tighten-chapter-spacing-strong',
    marginLeftMM: 18.75,
    marginRightMM: 18.75,
    lineHeightPt: 14.2,
    paragraphSpacingPt: 13.2,
  },
  {
    strategy: 'tighten-chapter-spacing-strong-plus',
    marginLeftMM: 18,
    marginRightMM: 18,
    lineHeightPt: 13.9,
    paragraphSpacingPt: 12.4,
  },
  {
    strategy: 'tighten-chapter-spacing-maximum',
    marginLeftMM: 17.25,
    marginRightMM: 17.25,
    lineHeightPt: 13.6,
    paragraphSpacingPt: 11.6,
  },
];

interface ChapterStartDetectionOptions {
  minimumPageNumber?: number;
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}: ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function extractAlternativeTitleCandidates(title: string): string[] {
  const trimmed = title.trim();
  const candidates = [trimmed];
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex !== -1) {
    candidates.push(trimmed.slice(colonIndex + 1).trim());
  }
  return unique(candidates.filter(Boolean));
}

export function buildIssueKey(
  issue: Pick<PrintQaIssue, 'code' | 'chapterNumber' | 'pageNumbers'>,
): string {
  const chapterKey = issue.chapterNumber ?? 'na';
  const pageKey = issue.pageNumbers?.join(',') ?? 'na';
  return `${issue.code}:${chapterKey}:${pageKey}`;
}

export function buildIssueComparisonKey(
  issue: Pick<PrintQaIssue, 'code' | 'chapterNumber' | 'pageNumbers'>,
): string {
  if (typeof issue.chapterNumber === 'number') {
    return `${issue.code}:chapter:${issue.chapterNumber}`;
  }

  if (issue.pageNumbers?.length) {
    return `${issue.code}:pages:${issue.pageNumbers.join(',')}`;
  }

  return `${issue.code}:global`;
}

export function extractSparseChapterNumbers(
  issues: Array<Pick<PrintQaIssue, 'code' | 'chapterNumber'>>,
): number[] {
  return unique(
    issues
      .filter(
        (
          issue,
        ): issue is Pick<PrintQaIssue, 'code' | 'chapterNumber'> & { chapterNumber: number } =>
          issue.code === 'chapter_sparse_last_page' && typeof issue.chapterNumber === 'number',
      )
      .map((issue) => issue.chapterNumber),
  ).sort((a, b) => a - b);
}

export function derivePrintQaStatus(
  report: PrintQaReport,
): 'passed' | 'passed_with_fixes' | 'critical_issues_remaining' {
  if (report.criticalErrors.length > 0) {
    return 'critical_issues_remaining';
  }

  if (report.autoFixesApplied.length > 0) {
    return 'passed_with_fixes';
  }

  return 'passed';
}

export function findChapterStartPages(
  pages: PageTextEntry[],
  chapterTitles: string[],
  options: ChapterStartDetectionOptions = {},
): Array<{ chapterNumber: number; title: string; pageNumber: number | null }> {
  const minimumPageNumber = options.minimumPageNumber ?? PRINT_FRONT_MATTER_PAGE_COUNT + 1;
  const normalizedPages = pages
    .filter((page) => page.num >= minimumPageNumber)
    .map((page) => ({
      pageNumber: page.num,
      text: normalizeSearchText(page.text),
    }));

  let pageCursor = 0;

  return chapterTitles.map((title, index) => {
    const candidates = extractAlternativeTitleCandidates(title).map(normalizeSearchText);
    let foundPageNumber: number | null = null;

    for (let i = pageCursor; i < normalizedPages.length; i += 1) {
      const page = normalizedPages[i];
      if (!page) {
        continue;
      }

      if (candidates.some((candidate) => candidate.length > 0 && page.text.includes(candidate))) {
        foundPageNumber = page.pageNumber;
        pageCursor = i + 1;
        break;
      }
    }

    return {
      chapterNumber: index + 1,
      title,
      pageNumber: foundPageNumber,
    };
  });
}

export function buildChapterRanges(
  starts: Array<{ chapterNumber: number; title: string; pageNumber: number | null }>,
  totalPages: number,
): ChapterPageReference[] {
  const foundStarts = starts.filter(
    (entry): entry is { chapterNumber: number; title: string; pageNumber: number } =>
      Number.isFinite(entry.pageNumber),
  );

  return foundStarts.map((start, index) => {
    const nextStart = foundStarts[index + 1];
    return {
      chapterNumber: start.chapterNumber,
      title: start.title,
      startPage: start.pageNumber,
      endPage: nextStart ? nextStart.pageNumber - 1 : totalPages,
    };
  });
}

export function detectUnexpectedBlankPages(
  pages: PageTextEntry[],
  imagePages: Set<number>,
): number[] {
  return pages
    .filter((page) => !imagePages.has(page.num))
    .filter((page) => page.text.replace(/\s+/g, '').length === 0)
    .map((page) => page.num);
}

export function detectSparseChapterEndings(
  pages: PageTextEntry[],
  chapterRanges: ChapterPageReference[],
  options: {
    maxNonEmptyLines?: number;
    maxCharacters?: number;
  } = {},
): SparseChapterEnding[] {
  const maxNonEmptyLines = options.maxNonEmptyLines ?? 5;
  const maxCharacters = options.maxCharacters ?? 260;
  const pageMap = new Map(pages.map((page) => [page.num, page.text]));

  return chapterRanges
    .filter((range) => range.endPage > range.startPage)
    .map((range) => {
      const finalPageText = pageMap.get(range.endPage) ?? '';
      const nonEmptyLines = finalPageText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const normalizedTextLength = finalPageText.replace(/\s+/g, ' ').trim().length;

      return {
        chapterNumber: range.chapterNumber,
        pageNumber: range.endPage,
        textLength: normalizedTextLength,
        nonEmptyLineCount: nonEmptyLines.length,
      };
    })
    .filter(
      (entry) =>
        entry.nonEmptyLineCount > 0 &&
        entry.nonEmptyLineCount <= maxNonEmptyLines &&
        entry.textLength <= maxCharacters,
    );
}

export function detectDoubleSpaceSnippets(html: string, maxMatches: number = 10): string[] {
  const matches = html.match(/.{0,40}\S {2,}\S.{0,40}/g) ?? [];
  return matches.slice(0, maxMatches).map((match) => match.trim());
}

export function detectInlineFontSizeOverrides(
  html: string,
  maxMatches: number = 10,
): Array<{ tagName: string; style: string; textPreview: string }> {
  const root = parse(html);
  return root
    .querySelectorAll('.chapter-content [style*="font-size"]')
    .slice(0, maxMatches)
    .map((node) => ({
      tagName: node.tagName.toLowerCase(),
      style: node.getAttribute('style') ?? '',
      textPreview: node.text.replace(/\s+/g, ' ').trim().slice(0, 120),
    }));
}

export function extractCoverSignals(html: string): {
  hasLogo: boolean;
  hasQrCode: boolean;
  spineText: string;
} {
  const root = parse(html);
  return {
    hasLogo: !!root.querySelector('.logo-img'),
    hasQrCode: !!root.querySelector('.qr-img'),
    spineText: root.querySelector('.spine')?.text.replace(/\s+/g, ' ').trim() ?? '',
  };
}

function parseMarginPair(block: string): { leftMM: number; rightMM: number } | null {
  const leftMatch = block.match(/margin-left:\s*([\d.]+)mm;/);
  const rightMatch = block.match(/margin-right:\s*([\d.]+)mm;/);
  if (!leftMatch?.[1] || !rightMatch?.[1]) {
    return null;
  }

  const leftMM = parseFloat(leftMatch[1]);
  const rightMM = parseFloat(rightMatch[1]);

  if (!Number.isFinite(leftMM) || !Number.isFinite(rightMM)) {
    return null;
  }

  return { leftMM, rightMM };
}

export function extractMarginSnapshot(html: string): MarginSnapshot {
  const defaultBlockMatch = html.match(/@page chapter\s*{([\s\S]*?)}/);
  const defaultMargins = parseMarginPair(defaultBlockMatch?.[1] ?? '') ?? {
    leftMM: null,
    rightMM: null,
  };

  const chapterMargins: Record<number, { leftMM: number; rightMM: number }> = {};
  const chapterRegex = /@page chapter-(\d+)\s*{([\s\S]*?)}/g;

  for (const match of html.matchAll(chapterRegex)) {
    const chapterNumber = parseInt(match[1] ?? '', 10);
    const marginPair = parseMarginPair(match[2] ?? '');
    if (!Number.isFinite(chapterNumber) || !marginPair) {
      continue;
    }
    chapterMargins[chapterNumber] = marginPair;
  }

  return {
    defaultMargins,
    chapterMargins,
  };
}

export function detectSafeZoneViolations(
  marginSnapshot: MarginSnapshot,
  minimumMarginMM: number,
): PrintQaIssue[] {
  const issues: PrintQaIssue[] = [];

  if (
    marginSnapshot.defaultMargins.leftMM !== null &&
    marginSnapshot.defaultMargins.rightMM !== null &&
    (marginSnapshot.defaultMargins.leftMM < minimumMarginMM ||
      marginSnapshot.defaultMargins.rightMM < minimumMarginMM)
  ) {
    issues.push({
      code: 'safe_margin_violation',
      severity: 'critical',
      message: `Default chapter margins fall below the ${minimumMarginMM}mm minimum safe margin.`,
      details: {
        leftMM: marginSnapshot.defaultMargins.leftMM,
        rightMM: marginSnapshot.defaultMargins.rightMM,
      },
      suggestedFix: 'Increase the default chapter page margins before exporting the PDF.',
    });
  }

  for (const [chapterNumberText, margins] of Object.entries(marginSnapshot.chapterMargins)) {
    if (margins.leftMM >= minimumMarginMM && margins.rightMM >= minimumMarginMM) {
      continue;
    }

    issues.push({
      code: 'safe_margin_violation',
      severity: 'critical',
      chapterNumber: parseInt(chapterNumberText, 10),
      message: `Chapter ${chapterNumberText} uses margins below the ${minimumMarginMM}mm minimum safe margin.`,
      details: margins,
      suggestedFix:
        'Relax the chapter override so the text block sits farther from the trim and gutter.',
    });
  }

  return issues;
}

function buildLayoutState(
  profileLevels: Record<number, number>,
): Pick<AutoFixCandidateAssessment, 'layoutOverrides' | 'layoutStrategies' | 'aggressionScore'> {
  const layoutOverrides: Record<number, ChapterLayoutOverride> = {};
  const layoutStrategies: Record<number, string> = {};
  let aggressionScore = 0;

  for (const [chapterNumberText, level] of Object.entries(profileLevels)) {
    if (!Number.isFinite(level) || level <= 0) {
      continue;
    }

    const profile = CHAPTER_LAYOUT_PROFILES[level - 1];
    const chapterNumber = parseInt(chapterNumberText, 10);
    if (!profile || !Number.isFinite(chapterNumber)) {
      continue;
    }

    layoutOverrides[chapterNumber] = {
      marginLeftMM: profile.marginLeftMM,
      marginRightMM: profile.marginRightMM,
      lineHeightPt: profile.lineHeightPt,
      paragraphSpacingPt: profile.paragraphSpacingPt,
    };
    layoutStrategies[chapterNumber] = profile.strategy;
    aggressionScore += level;
  }

  return {
    layoutOverrides,
    layoutStrategies,
    aggressionScore,
  };
}

export function buildChapterLayoutOverrideAttempts(params: {
  currentProfileLevels: Record<number, number>;
  unresolvedChapterNumbers: number[];
}): Array<{
  strategy: string;
  layoutOverrides: Record<number, ChapterLayoutOverride>;
  layoutStrategies: Record<number, string>;
  profileLevels: Record<number, number>;
  aggressionScore: number;
}> {
  const unresolvedChapterNumbers = unique(params.unresolvedChapterNumbers).sort((a, b) => a - b);
  const attempts: Array<{
    strategy: string;
    layoutOverrides: Record<number, ChapterLayoutOverride>;
    layoutStrategies: Record<number, string>;
    profileLevels: Record<number, number>;
    aggressionScore: number;
  }> = [];

  for (const chapterNumber of unresolvedChapterNumbers) {
    const currentLevel = params.currentProfileLevels[chapterNumber] ?? 0;
    for (
      let nextLevel = currentLevel + 1;
      nextLevel <= CHAPTER_LAYOUT_PROFILES.length;
      nextLevel += 1
    ) {
      const profile = CHAPTER_LAYOUT_PROFILES[nextLevel - 1];
      if (!profile) {
        continue;
      }

      const profileLevels = {
        ...params.currentProfileLevels,
        [chapterNumber]: nextLevel,
      };
      const layoutState = buildLayoutState(profileLevels);

      attempts.push({
        strategy: `escalate-chapter-${chapterNumber}-to-${profile.strategy}`,
        layoutOverrides: layoutState.layoutOverrides,
        layoutStrategies: layoutState.layoutStrategies,
        profileLevels,
        aggressionScore: layoutState.aggressionScore,
      });
    }
  }

  return attempts;
}

export function getMinimumMarginMM(
  layoutOverrides: Record<number, ChapterLayoutOverride>,
  defaultMarginMM: number = 21,
): number {
  const margins = [defaultMarginMM];

  for (const override of Object.values(layoutOverrides)) {
    margins.push(override.marginLeftMM ?? defaultMarginMM);
    margins.push(override.marginRightMM ?? defaultMarginMM);
  }

  return Math.min(...margins);
}

export function chooseBestSafeImprovedVariant(params: {
  baselineCriticalIssueComparisonKeys: string[];
  baselineSparseChapterNumbers: number[];
  candidates: AutoFixCandidateAssessment[];
  minimumSafeMarginMM: number;
}): AutoFixCandidateAssessment | null {
  const baselineCriticalIssueSet = new Set(params.baselineCriticalIssueComparisonKeys);
  const baselineSparseChapterSet = new Set(params.baselineSparseChapterNumbers);

  const rankedCandidates = params.candidates
    .map((candidate) =>
      evaluateAutoFixCandidate({
        baselineCriticalIssueComparisonKeys: baselineCriticalIssueSet,
        baselineSparseChapterNumbers: baselineSparseChapterSet,
        candidate,
        minimumSafeMarginMM: params.minimumSafeMarginMM,
      }),
    )
    .filter((evaluation) => evaluation.qualifies)
    .sort((left, right) => {
      if (left.resolvedSparseIssueCount !== right.resolvedSparseIssueCount) {
        return right.resolvedSparseIssueCount - left.resolvedSparseIssueCount;
      }

      if (left.remainingSparseIssueCount !== right.remainingSparseIssueCount) {
        return left.remainingSparseIssueCount - right.remainingSparseIssueCount;
      }

      if (left.candidate.aggressionScore !== right.candidate.aggressionScore) {
        return left.candidate.aggressionScore - right.candidate.aggressionScore;
      }

      return left.candidate.attemptIndex - right.candidate.attemptIndex;
    });

  return rankedCandidates[0]?.candidate ?? null;
}

export function evaluateAutoFixCandidate(params: {
  baselineCriticalIssueComparisonKeys: Set<string> | string[];
  baselineSparseChapterNumbers: Set<number> | number[];
  candidate: AutoFixCandidateAssessment;
  minimumSafeMarginMM: number;
}): AutoFixCandidateEvaluation {
  const baselineCriticalIssueSet =
    params.baselineCriticalIssueComparisonKeys instanceof Set
      ? params.baselineCriticalIssueComparisonKeys
      : new Set(params.baselineCriticalIssueComparisonKeys);
  const baselineSparseChapterSet =
    params.baselineSparseChapterNumbers instanceof Set
      ? params.baselineSparseChapterNumbers
      : new Set(params.baselineSparseChapterNumbers);
  const candidateIssueSet = new Set(params.candidate.criticalIssueComparisonKeys);
  const candidateSparseChapterSet = new Set(params.candidate.sparseChapterNumbers);
  const newCriticalIssueKeys = [...candidateIssueSet].filter(
    (key) => !baselineCriticalIssueSet.has(key),
  );
  const resolvedSparseIssueCount = [...baselineSparseChapterSet].filter(
    (chapterNumber) => !candidateSparseChapterSet.has(chapterNumber),
  ).length;
  const rejectionReasons: AutoFixCandidateEvaluation['rejectionReasons'] = [];

  if (params.candidate.minMarginMM < params.minimumSafeMarginMM) {
    rejectionReasons.push('below_margin_floor');
  }

  if (newCriticalIssueKeys.length > 0) {
    rejectionReasons.push('new_critical');
  }

  if (resolvedSparseIssueCount === 0) {
    rejectionReasons.push('no_improvement');
  }

  if (params.candidate.sparseChapterNumbers.length > 0) {
    rejectionReasons.push('still_sparse');
  }

  const blockingReasons = rejectionReasons.filter((reason) => reason !== 'still_sparse');

  return {
    candidate: params.candidate,
    qualifies: blockingReasons.length === 0,
    newCriticalIssueKeys,
    resolvedSparseIssueCount,
    remainingSparseIssueCount: params.candidate.sparseChapterNumbers.length,
    rejectionReasons,
  };
}

export function buildManualNextSteps(
  report: Pick<PrintQaReport, 'criticalErrors' | 'warnings' | 'autoFixesApplied'>,
): string[] {
  const steps: string[] = [];

  if (report.criticalErrors.length > 0) {
    for (const issue of report.criticalErrors) {
      if (issue.suggestedFix) {
        steps.push(issue.suggestedFix);
      }
    }
  }

  if (report.autoFixesApplied.length > 0) {
    steps.push(
      'Review the regenerated interior PDF and confirm the chapter reflow still matches editorial intent.',
    );
  }

  if (steps.length === 0 && report.warnings.length > 0) {
    steps.push(
      'Review the warnings in the QA report and decide whether any aesthetic adjustments should be applied before print submission.',
    );
  }

  return unique(steps);
}
