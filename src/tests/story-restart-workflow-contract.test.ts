import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

type WorkflowNode = Record<string, unknown> | unknown[] | string | number | boolean | null;

const parsedWorkflow = parse(
  readFileSync(resolve(process.cwd(), 'workflows/story-generation.yaml'), 'utf8'),
) as Record<string, unknown>;

function findNamedStep(node: WorkflowNode, stepName: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findNamedStep(item as WorkflowNode, stepName);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  if (stepName in record) return record[stepName] as Record<string, unknown>;
  for (const value of Object.values(record)) {
    const found = findNamedStep(value as WorkflowNode, stepName);
    if (found) return found;
  }
  return undefined;
}

function namedStepIndex(steps: unknown[], stepName: string): number {
  return steps.findIndex(
    (step) => Boolean(step) && typeof step === 'object' && stepName in (step as object),
  );
}

describe('story generation workflow contract', () => {
  it('claims the stable run id before starting generation', () => {
    const runPipeline = findNamedStep(parsedWorkflow as WorkflowNode, 'runPipeline') as {
      try: { steps: unknown[] };
    };
    const claimIndex = namedStepIndex(runPipeline.try.steps, 'claimRun');
    const duplicateStopIndex = namedStepIndex(runPipeline.try.steps, 'stopDuplicateRun');
    const outlineIndex = namedStepIndex(runPipeline.try.steps, 'genOutline');

    expect(claimIndex).toBeGreaterThan(-1);
    expect(duplicateStopIndex).toBeGreaterThan(claimIndex);
    expect(outlineIndex).toBeGreaterThan(duplicateStopIndex);
    expect(findNamedStep(parsedWorkflow as WorkflowNode, 'outlineRequest')).toMatchObject({
      call: 'http.request',
    });
  });

  it('keeps each chapter persistence and image lifecycle in the same sequential branch', () => {
    const chaptersAndCovers = findNamedStep(
      parsedWorkflow as WorkflowNode,
      'chaptersAndCovers',
    ) as {
      parallel: { branches: Array<Record<string, { steps: unknown[] }>> };
    };
    const chapterBranch = chaptersAndCovers.parallel.branches.find(
      (branch) => branch.chapterPipelineBranch,
    )?.chapterPipelineBranch;
    const coverBranch = chaptersAndCovers.parallel.branches.find(
      (branch) => branch.coverBranch,
    )?.coverBranch;

    expect(chapterBranch).toBeDefined();
    expect(coverBranch).toBeDefined();
    expect(findNamedStep(chapterBranch as WorkflowNode, 'saveChapter')).toMatchObject({
      result: 'savedChapterResp',
    });
    expect(findNamedStep(chapterBranch as WorkflowNode, 'chapterImageRequest')).toMatchObject({
      args: {
        body: expect.objectContaining({
          chapterId: '${savedChapterResp.body.chapterId}',
          chapterVersion: '${savedChapterResp.body.version}',
        }),
      },
    });
    expect(findNamedStep(chapterBranch as WorkflowNode, 'storeChapterImageResult')).toMatchObject({
      args: {
        body: expect.objectContaining({
          chapterId: '${savedChapterResp.body.chapterId}',
          chapterVersion: '${savedChapterResp.body.version}',
        }),
      },
    });
    expect(findNamedStep(coverBranch as WorkflowNode, 'chapterImageRequest')).toBeUndefined();
  });

  it('treats chapter persistence conflicts as terminal and completes only after asset branches', () => {
    const terminalSwitch = findNamedStep(
      parsedWorkflow as WorkflowNode,
      'rethrowNonRetryableChapterImage',
    ) as { switch: Array<{ condition: string }> };
    expect(terminalSwitch.switch[0]?.condition).toContain('terminalChapterImageErrorCode == 409');

    const runPipeline = findNamedStep(parsedWorkflow as WorkflowNode, 'runPipeline') as {
      try: { steps: unknown[] };
    };
    const branchIndex = namedStepIndex(runPipeline.try.steps, 'handleOutlineOutcome');
    const completionIndex = namedStepIndex(runPipeline.try.steps, 'markCompleted');
    expect(branchIndex).toBeGreaterThan(-1);
    expect(completionIndex).toBeGreaterThan(branchIndex);
  });
});
