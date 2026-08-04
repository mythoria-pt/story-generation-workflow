import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('story restart workflow contract', () => {
  const workflow = readFileSync(resolve(process.cwd(), 'workflows/story-generation.yaml'), 'utf8');

  it('claims the stable run id before starting generation', () => {
    const claim = workflow.indexOf('/internal/runs/" + runId + "/claim');
    const duplicateStop = workflow.indexOf('stopDuplicateRun:');
    const outline = workflow.indexOf('/ai/text/outline');

    expect(claim).toBeGreaterThan(-1);
    expect(duplicateStop).toBeGreaterThan(claim);
    expect(outline).toBeGreaterThan(duplicateStop);
  });

  it('persists narrative and image assets before marking the run completed', () => {
    const chapterPersistence = workflow.indexOf('/chapter/" + string(chapterNum)');
    const imagePersistence = workflow.indexOf('/internal/runs/" + runId + "/image');
    const completion = workflow.indexOf("status: 'completed'");

    expect(chapterPersistence).toBeGreaterThan(-1);
    expect(imagePersistence).toBeGreaterThan(chapterPersistence);
    expect(completion).toBeGreaterThan(imagePersistence);
  });
});
