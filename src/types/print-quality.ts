export interface ChapterLayoutOverride {
  marginLeftMM?: number;
  marginRightMM?: number;
  lineHeightPt?: number;
  paragraphSpacingPt?: number;
}

export interface PrintQaIssue {
  code: string;
  message: string;
  severity: 'warning' | 'critical';
  chapterNumber?: number;
  pageNumbers?: number[];
  details?: Record<string, unknown>;
  suggestedFix?: string;
}

export interface PrintQaFixApplied {
  chapterNumber: number;
  strategy: string;
  layoutOverride: ChapterLayoutOverride;
}

export interface PrintQaPreview {
  key: string;
  label: string;
  storagePath: string;
  url?: string;
}

export interface PrintQaReport {
  bookTitle: string;
  storyId: string;
  runId: string;
  generatedAt: string;
  totalInteriorPages: number;
  passes: string[];
  warnings: PrintQaIssue[];
  criticalErrors: PrintQaIssue[];
  autoFixesApplied: PrintQaFixApplied[];
  manualNextSteps: string[];
  previews?: PrintQaPreview[];
}

export interface PrintQaAssetUrls {
  interiorPdfUrl: string;
  coverPdfUrl: string;
  interiorCmykPdfUrl?: string | null;
  coverCmykPdfUrl?: string | null;
}

export interface PrintQaCheckResult {
  qaStatus: 'passed' | 'passed_with_fixes' | 'critical_issues_remaining' | 'review_failed';
  reportUrl: string | null;
  passCount: number;
  warningCount: number;
  criticalCount: number;
  alertNeeded: boolean;
  fixesApplied: PrintQaFixApplied[];
  criticalErrors: PrintQaIssue[];
  warnings: PrintQaIssue[];
  printResult: PrintQaAssetUrls;
}
