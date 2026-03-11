import { describe, expect, it } from '@jest/globals';
import {
  buildChapterLayoutOverrideAttempts,
  buildIssueComparisonKey,
  buildIssueKey,
  chooseBestSafeImprovedVariant,
  derivePrintQaStatus,
  detectSafeZoneViolations,
  detectSparseChapterEndings,
  evaluateAutoFixCandidate,
  extractMarginSnapshot,
  findChapterStartPages,
} from '@/services/print-quality-rules.js';

describe('print-quality-rules', () => {
  it('flags sparse chapter ending pages with low occupancy', () => {
    const sparseEndings = detectSparseChapterEndings(
      [
        { num: 7, text: 'Chapter 1: The Lake\nA full opening page of text.' },
        { num: 8, text: 'More text on the previous page.\nStill dense and healthy.' },
        { num: 9, text: 'Only one final line.' },
      ],
      [
        {
          chapterNumber: 1,
          title: 'Chapter 1: The Lake',
          startPage: 7,
          endPage: 9,
        },
      ],
    );

    expect(sparseEndings).toEqual([
      expect.objectContaining({
        chapterNumber: 1,
        pageNumber: 9,
      }),
    ]);
  });

  it('skips front matter TOC matches and keeps chapter starts strictly increasing', () => {
    const chapterTitles = [
      'O Mapa Brilhante',
      'A Tempestade de Bolhas',
      'O Espelho de Água',
      'O Maior Tesouro do Mundo',
    ];

    const starts = findChapterStartPages(
      [
        {
          num: 5,
          text: `Índice
          ${chapterTitles.join('\n')}`,
        },
        { num: 6, text: 'O Mapa Brilhante\nTexto do primeiro capítulo.' },
        { num: 12, text: 'A Tempestade de Bolhas\nTexto do segundo capítulo.' },
        { num: 16, text: 'O Espelho de Água\nTexto do terceiro capítulo.' },
        { num: 22, text: 'O Maior Tesouro do Mundo\nTexto do quarto capítulo.' },
      ],
      chapterTitles,
    );

    expect(starts).toEqual([
      { chapterNumber: 1, title: 'O Mapa Brilhante', pageNumber: 6 },
      { chapterNumber: 2, title: 'A Tempestade de Bolhas', pageNumber: 12 },
      { chapterNumber: 3, title: 'O Espelho de Água', pageNumber: 16 },
      { chapterNumber: 4, title: 'O Maior Tesouro do Mundo', pageNumber: 22 },
    ]);
  });

  it('detects safe-zone violations from chapter margin overrides', () => {
    const marginSnapshot = extractMarginSnapshot(`
      <style>
        @page chapter {
          margin-left: 21mm;
          margin-right: 21mm;
        }

        @page chapter-3 {
          margin-left: 4.5mm;
          margin-right: 4.5mm;
        }
      </style>
    `);

    const issues = detectSafeZoneViolations(marginSnapshot, 5);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual(
      expect.objectContaining({
        code: 'safe_margin_violation',
        chapterNumber: 3,
      }),
    );
  });

  it('builds per-chapter auto-fix candidates across all body-only profiles', () => {
    const attempts = buildChapterLayoutOverrideAttempts({
      currentProfileLevels: {},
      unresolvedChapterNumbers: [1, 3],
    });

    expect(attempts).toHaveLength(10);
    expect(attempts[0]).toEqual(
      expect.objectContaining({
        strategy: 'escalate-chapter-1-to-tighten-chapter-spacing-soft',
        layoutStrategies: {
          1: 'tighten-chapter-spacing-soft',
        },
      }),
    );
    expect(attempts[1]).toEqual(
      expect.objectContaining({
        strategy: 'escalate-chapter-1-to-tighten-chapter-spacing-medium',
        layoutStrategies: {
          1: 'tighten-chapter-spacing-medium',
        },
      }),
    );
    expect(attempts[2]).toEqual(
      expect.objectContaining({
        strategy: 'escalate-chapter-1-to-tighten-chapter-spacing-strong',
        layoutStrategies: {
          1: 'tighten-chapter-spacing-strong',
        },
      }),
    );
    expect(attempts[3]).toEqual(
      expect.objectContaining({
        strategy: 'escalate-chapter-1-to-tighten-chapter-spacing-strong-plus',
        layoutStrategies: {
          1: 'tighten-chapter-spacing-strong-plus',
        },
      }),
    );
    expect(attempts[4]).toEqual(
      expect.objectContaining({
        strategy: 'escalate-chapter-1-to-tighten-chapter-spacing-maximum',
        layoutStrategies: {
          1: 'tighten-chapter-spacing-maximum',
        },
      }),
    );
    expect(attempts[5]).toEqual(
      expect.objectContaining({
        strategy: 'escalate-chapter-3-to-tighten-chapter-spacing-soft',
        layoutStrategies: {
          3: 'tighten-chapter-spacing-soft',
        },
      }),
    );
  });

  it('only considers stronger profiles beyond the chapter current level', () => {
    const attempts = buildChapterLayoutOverrideAttempts({
      currentProfileLevels: {
        1: 1,
        3: 2,
      },
      unresolvedChapterNumbers: [3, 4],
    });

    expect(attempts.map((attempt) => attempt.strategy)).toEqual([
      'escalate-chapter-3-to-tighten-chapter-spacing-strong',
      'escalate-chapter-3-to-tighten-chapter-spacing-strong-plus',
      'escalate-chapter-3-to-tighten-chapter-spacing-maximum',
      'escalate-chapter-4-to-tighten-chapter-spacing-soft',
      'escalate-chapter-4-to-tighten-chapter-spacing-medium',
      'escalate-chapter-4-to-tighten-chapter-spacing-strong',
      'escalate-chapter-4-to-tighten-chapter-spacing-strong-plus',
      'escalate-chapter-4-to-tighten-chapter-spacing-maximum',
    ]);
  });

  it('treats unresolved sparse chapters as acceptable when a candidate still improves the baseline', () => {
    const evaluation = evaluateAutoFixCandidate({
      baselineCriticalIssueComparisonKeys: [
        buildIssueComparisonKey({
          code: 'chapter_sparse_last_page',
          chapterNumber: 1,
          pageNumbers: [10],
        }),
        buildIssueComparisonKey({
          code: 'chapter_sparse_last_page',
          chapterNumber: 3,
          pageNumbers: [20],
        }),
      ],
      baselineSparseChapterNumbers: [1, 3],
      minimumSafeMarginMM: 5,
      candidate: {
        attemptIndex: 7,
        strategy: 'partial-safe-improvement',
        layoutOverrides: {},
        layoutStrategies: {
          1: 'tighten-chapter-spacing-soft',
        },
        profileLevels: {
          1: 1,
        },
        criticalIssueComparisonKeys: [
          buildIssueComparisonKey({
            code: 'chapter_sparse_last_page',
            chapterNumber: 3,
            pageNumbers: [19],
          }),
        ],
        sparseChapterNumbers: [3],
        minMarginMM: 20.25,
        aggressionScore: 1,
      },
    });

    expect(evaluation.qualifies).toBe(true);
    expect(evaluation.resolvedSparseIssueCount).toBe(1);
    expect(evaluation.remainingSparseIssueCount).toBe(1);
    expect(evaluation.rejectionReasons).toEqual(['still_sparse']);
  });

  it('chooses the best safe improved auto-fix candidate', () => {
    const sparseIssueKey = buildIssueKey({
      code: 'chapter_sparse_last_page',
      chapterNumber: 2,
      pageNumbers: [41],
    });

    const accepted = chooseBestSafeImprovedVariant({
      baselineCriticalIssueComparisonKeys: [
        buildIssueComparisonKey({
          code: 'chapter_sparse_last_page',
          chapterNumber: 2,
          pageNumbers: [41],
        }),
        buildIssueComparisonKey({
          code: 'cover_logo_missing',
        }),
      ],
      baselineSparseChapterNumbers: [2],
      minimumSafeMarginMM: 5,
      candidates: [
        {
          attemptIndex: 1,
          strategy: 'too-tight',
          layoutOverrides: {},
          layoutStrategies: {},
          profileLevels: { 2: 3 },
          criticalIssueComparisonKeys: [
            buildIssueComparisonKey({
              code: 'chapter_sparse_last_page',
              chapterNumber: 2,
              pageNumbers: [39],
            }),
          ],
          sparseChapterNumbers: [2],
          minMarginMM: 4.5,
          aggressionScore: 3,
        },
        {
          attemptIndex: 2,
          strategy: 'introduces-blank-page',
          layoutOverrides: {},
          layoutStrategies: {},
          profileLevels: { 2: 2 },
          criticalIssueComparisonKeys: [
            buildIssueComparisonKey({
              code: 'cover_logo_missing',
            }),
            buildIssueComparisonKey({
              code: 'unexpected_blank_page',
              pageNumbers: [44],
            }),
          ],
          sparseChapterNumbers: [],
          minMarginMM: 19.5,
          aggressionScore: 2,
        },
        {
          attemptIndex: 3,
          strategy: 'safe-medium',
          layoutOverrides: {},
          layoutStrategies: {},
          profileLevels: { 2: 2 },
          criticalIssueComparisonKeys: [
            buildIssueComparisonKey({
              code: 'cover_logo_missing',
            }),
          ],
          sparseChapterNumbers: [],
          minMarginMM: 19.5,
          aggressionScore: 2,
        },
      ],
    });

    expect(accepted).toEqual(
      expect.objectContaining({
        attemptIndex: 3,
      }),
    );
    expect(sparseIssueKey).toBe('chapter_sparse_last_page:2:41');
  });

  it('derives passed_with_fixes when no critical errors remain', () => {
    const status = derivePrintQaStatus({
      bookTitle: 'My Book',
      storyId: 'story-1',
      runId: 'run-1',
      generatedAt: new Date().toISOString(),
      totalInteriorPages: 64,
      passes: ['All good'],
      warnings: [],
      criticalErrors: [],
      autoFixesApplied: [
        {
          chapterNumber: 2,
          strategy: 'tighten-chapter-spacing-soft',
          layoutOverride: {
            marginLeftMM: 20.25,
            marginRightMM: 20.25,
          },
        },
      ],
      manualNextSteps: [],
    });

    expect(status).toBe('passed_with_fixes');
  });
});
