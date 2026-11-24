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
  it('resolves the durable book type before chapter planning and fences failures to the claimant', () => {
    const runPipeline = findNamedStep(parsedWorkflow as WorkflowNode, 'runPipeline') as {
      try: { steps: unknown[] };
      except: { steps: unknown[] };
    };
    const steps = runPipeline.try.steps;
    expect(namedStepIndex(steps, 'resolveBookType')).toBeGreaterThan(
      namedStepIndex(steps, 'recordClaim'),
    );
    expect(namedStepIndex(steps, 'runPremiumBook')).toBeLessThan(
      namedStepIndex(steps, 'genOutline'),
    );
    expect(findNamedStep(parsedWorkflow as WorkflowNode, 'selectClaim')).toMatchObject({
      switch: [{ condition: '${resumeUpdatedAt != null}', next: 'claimPremiumResume' }],
    });
    expect(findNamedStep(parsedWorkflow as WorkflowNode, 'claimPremiumResume')).toMatchObject({
      args: {
        body: expect.objectContaining({
          storyId: '${storyId}',
          updatedAt: '${resumeUpdatedAt}',
          executionId: '${executionId}',
        }),
      },
    });
    for (const step of ['claimRun', 'claimPremiumResume', 'markFailedRun']) {
      expect(findNamedStep(parsedWorkflow as WorkflowNode, step)).toMatchObject({
        args: { headers: { 'x-api-key': '${apiKey}' } },
      });
    }
    expect(findNamedStep(parsedWorkflow as WorkflowNode, 'completePremiumBook')).toMatchObject({
      try: { args: { headers: { 'x-api-key': '${apiKey}' } } },
    });
    expect(namedStepIndex(runPipeline.except.steps, 'preserveUnclaimedRun')).toBeLessThan(
      namedStepIndex(runPipeline.except.steps, 'markFailedRun'),
    );
    expect(findNamedStep(parsedWorkflow as WorkflowNode, 'preserveUnclaimedRun')).toMatchObject({
      switch: [{ condition: '${not(runClaimed)}', raise: '${wfError}' }],
    });
  });
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
    expect(findNamedStep(chapterBranch as WorkflowNode, 'chapterRequest')).toMatchObject({
      call: 'advanceText',
      args: {
        runId: '${runId}',
        chapterNumber: '${chapterNum}',
      },
      result: 'chapterRespTemp',
    });
    expect(findNamedStep(chapterBranch as WorkflowNode, 'saveChapterTextResponse')).toMatchObject({
      assign: expect.arrayContaining([{ chapterResp: '${chapterRespTemp}' }]),
    });
    expect(findNamedStep(chapterBranch as WorkflowNode, 'usePersistedChapter')).toMatchObject({
      assign: [{ savedChapterResp: '${chapterResp}' }],
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

  it('records terminal errors when the exception is a string or its map lacks a message', () => {
    expect(findNamedStep(parsedWorkflow as WorkflowNode, 'markFailedRun')).toMatchObject({
      args: {
        body: {
          errorMessage:
            '${if(get_type(wfError) == "string", wfError, default(map.get(wfError, "message"), "Workflow execution failed"))}',
        },
      },
    });
  });

  it.each([
    [
      'frontCover',
      'tryFrontCoverGeneration',
      'stopFrontCoverRetry',
      'delayFrontCoverRetry',
      'logFrontCoverSkip',
    ],
    [
      'backCover',
      'tryBackCoverGeneration',
      'stopBackCoverRetry',
      'delayBackCoverRetry',
      'logBackCoverSkip',
    ],
    [
      'chapterImage',
      'tryChapterImageGeneration',
      'stopNonRetryableChapterImage',
      'delayChapterImageRetry',
      'logChapterImageSkip',
    ],
  ])(
    'only sleeps before another retryable %s request and safely logs a skipped image',
    (image, attemptStep, guardStep, delayStep, skipStep) => {
      const attempt = findNamedStep(parsedWorkflow as WorkflowNode, attemptStep) as {
        except: { steps: unknown[] };
      };
      const steps = attempt.except.steps;
      const guardIndex = namedStepIndex(steps, guardStep);
      expect(guardIndex).toBeGreaterThan(-1);
      expect(namedStepIndex(steps, delayStep)).toBeGreaterThan(guardIndex);
      const code = `${image}ErrorCode`;
      expect(findNamedStep(steps as WorkflowNode, guardStep)).toMatchObject({
        switch: expect.arrayContaining([
          {
            condition: `\${attempt >= ${image}MaxAttempts or not(${code} == 0 or ${code} == 408 or ${code} == 422 or ${code} == 429 or ${code} >= 500)}`,
            next: 'break',
          },
        ]),
      });

      const skipLog = findNamedStep(parsedWorkflow as WorkflowNode, skipStep) as {
        call: string;
        args: { text: string };
      };
      expect(skipLog.call).toBe('sys.log');
      expect(skipLog.args.text).toContain(`default(map.get(${image}LastError, "code"), "unknown")`);
      expect(skipLog.args.text).not.toContain('.message');
    },
  );
});
