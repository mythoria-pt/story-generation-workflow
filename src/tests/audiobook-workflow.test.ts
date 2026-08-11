import { readFileSync } from 'fs';
import { join } from 'path';

describe('Audiobook workflow retry contract', () => {
  const workflow = readFileSync(
    join(process.cwd(), 'workflows', 'audiobook-generation.yaml'),
    'utf8',
  );
  const audioRoute = readFileSync(join(process.cwd(), 'src', 'routes', 'audio.ts'), 'utf8');

  it('uses the Gemini default voice and bounds layered retries', () => {
    expect(workflow).toContain('voice: ${default(payload.voice, "Charon")}');
    expect(workflow).toContain('chapterAudioMaxAttempts: 2');
    expect(audioRoute).toContain('const selectedVoice = requestedVoice || getTTSConfig().voice;');
    expect(audioRoute).not.toContain("voice: voice || 'coral'");
    expect(audioRoute).not.toContain("voice: voice || 'nova'");
  });

  it('stops non-retryable chapter failures and fails the workflow execution', () => {
    expect(workflow).toContain('classifyChapterAudioRetryability');
    expect(workflow).toContain('raiseChapterAudioNonRetryable');
    expect(workflow).toContain('raiseChapterAudioFailure');
    expect(workflow).toContain('rethrowAudioError');
    expect(workflow).not.toContain('if(type(');
    expect(workflow).not.toContain('get_type(');
    expect(workflow).toContain('chapterAudioAttemptError.message');
    expect(workflow).not.toContain('returnAudioError');
  });

  it('claims one run and reports the complete terminal lifecycle with the same runId', () => {
    expect(workflow).toContain('/internal/runs/" + runId + "/claim');
    expect(workflow.indexOf('- claimRun:')).toBeLessThan(
      workflow.indexOf('- generateChapterAudios:'),
    );
    expect(workflow).toContain('runId: ${runId}');
    expect(workflow).toContain('expectedChapters: ${len(chapters)}');
    expect(workflow).toContain('generatedChapters: ${finalizeResp.body.chaptersProcessed}');
    expect(workflow).toContain('validateAudiobookCompleteness');
  });
});
